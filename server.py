import argparse
import json
import logging
import mimetypes
import re
import secrets
import shutil
import threading
import time
import webbrowser
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import quote, urlsplit

try:
    from yt_dlp import YoutubeDL
    from yt_dlp.utils import DownloadError
    from yt_dlp.version import __version__ as YTDLP_VERSION
except ModuleNotFoundError as error:
    if error.name != "yt_dlp":
        raise
    raise SystemExit("请先运行 python -m pip install -r requirements.txt，再启动服务。") from error


ROOT = Path(__file__).resolve().parent
FFMPEG = shutil.which("ffmpeg")
JS_RUNTIMES = {name: {"path": path} for name in ("deno", "node") if (path := shutil.which(name))}
RETENTION = 30 * 60
VIDEO_EXTS = {"mp4", "webm", "mkv", "mov", "avi", "flv", "m4v", "3gp", "ts", "mpg", "mpeg", "ogg"}
AUDIO_EXTS = {"aac", "alac", "flac", "m4a", "mka", "mp3", "ogg", "opus", "vorbis", "wav", "weba"}
MEDIA_EXTS = VIDEO_EXTS | AUDIO_EXTS
STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/demo": ("demo.html", "text/html; charset=utf-8"),
    "/demo.mp4": ("demo.mp4", "video/mp4"),
    "/demo.jpg": ("demo.jpg", "image/jpeg"),
}


class UserError(Exception):
    def __init__(self, message, status=400, detail=None):
        super().__init__(message)
        self.status = status
        self.detail = detail


def media_url(value):
    if not isinstance(value, str):
        return None
    value = value.strip()
    if len(value) > 4000 or re.search(r"[\x00-\x20\x7f\\]", value):
        return None
    try:
        parts = urlsplit(value)
        if (parts.scheme in {"http", "https"} and parts.hostname
                and parts.username is None and parts.port != 0):
            return value
    except ValueError:
        pass
    return None


class QuietLogger:
    def debug(self, message):
        pass

    warning = error = debug


def reject_live_or_playlist(info, *, incomplete=False):
    if info.get("is_live"):
        return "此链接正在直播。请使用已发布的录像链接。"
    if info.get("_type") in {"playlist", "multi_video"}:
        return "请粘贴单个视频链接。"
    return None


def engine_options():
    return {
        "quiet": True,
        "logger": QuietLogger(),
        "noplaylist": True,
        "playlistend": 1,
        "extract_flat": "in_playlist",
        "cachedir": False,
        "socket_timeout": 15,
        "retries": 2,
        "fragment_retries": 3,
        "js_runtimes": JS_RUNTIMES,
        "ffmpeg_location": FFMPEG,
        "match_filter": reject_live_or_playlist,
    }


def engine_error(error, message):
    detail = re.sub(r"\x1b\[[0-9;]*m", "", str(error)).removeprefix("ERROR: ").strip()[:800]
    lower = detail.lower()
    if "正在直播" in detail or "单个视频链接" in detail:
        return UserError(detail.split("ERROR: ")[-1], 422)
    if "drm" in lower:
        return UserError("这个视频受 DRM 保护，无法下载。", 422)
    if "unsupported url" in lower or "no video" in lower:
        return UserError("这个页面没有找到可下载的视频。试试单个视频的播放页或媒体直链。", 422, detail)
    return UserError(message, 422, detail)


def usable_format(item):
    if not item.get("format_id") or not item.get("url") or item.get("has_drm"):
        return False
    return item.get("ext") in MEDIA_EXTS


def track_kind(item):
    if item.get("vcodec") == "none" or (
        not item.get("vcodec") and item["ext"] in AUDIO_EXTS - VIDEO_EXTS
    ):
        return "audio" if item.get("acodec") != "none" else None
    return "video-only" if item.get("acodec") == "none" else "video"


@dataclass(frozen=True)
class Choice:
    video_or_audio: str
    audio: str | None
    extension: str

    def select(self, context):
        formats = {item["format_id"]: item for item in context["formats"] if usable_format(item)}
        track = formats.get(self.video_or_audio)
        if track is None:
            return
        if self.audio is None:
            yield track
            return
        audio = formats.get(self.audio)
        if audio:
            yield {
                "format_id": f"{self.video_or_audio}+{self.audio}",
                "ext": self.extension,
                "requested_formats": [track, audio],
                "protocol": f'{track["protocol"]}+{audio["protocol"]}',
            }


def available_choices(info):
    formats = [item for item in reversed(info.get("formats") or [info]) if usable_format(item)]
    audio_formats = [item for item in formats if track_kind(item) == "audio"]
    result = []
    seen = set()
    for item in formats:
        kind = track_kind(item)
        if kind is None:
            continue
        height = item.get("height")
        ext = item["ext"]
        audio = None
        if kind == "video-only" and audio_formats and FFMPEG:
            compatible_ext = {"mp4": "m4a", "webm": "webm"}.get(ext)
            compatible = next((track for track in audio_formats if track["ext"] == compatible_ext), None)
            audio = compatible or audio_formats[0]
            ext = ext if compatible else "mkv"
            kind = "video"
        key = (kind, ext, height or item.get("resolution"), item.get("fps"), item.get("language"))
        if key in seen:
            continue
        seen.add(key)
        size = item.get("filesize") or item.get("filesize_approx")
        estimated = not bool(item.get("filesize"))
        if audio:
            audio_size = audio.get("filesize") or audio.get("filesize_approx")
            size = size + audio_size if size and audio_size else None
            estimated = True
        public = {
            "kind": kind,
            "extension": ext,
            "height": height,
            "fps": item.get("fps"),
            "bitrate": (item.get("abr") or item.get("tbr")) if kind == "audio" else None,
            "language": (item.get("language") or "").strip() or None,
            "bytes": size,
            "estimated": estimated,
            "merge": audio is not None,
        }
        result.append((public, Choice(item["format_id"], audio and audio["format_id"], ext)))

    result.sort(key=lambda row: (
        {"video": 0, "video-only": 1, "audio": 2}[row[0]["kind"]],
        -(row[0]["height"] or 0),
        -(row[0]["fps"] or 0),
    ))
    choices = {}
    public_choices = []
    for index, (public, choice) in enumerate(result, 1):
        identifier = str(index)
        choices[identifier] = choice
        public_choices.append({"id": identifier, **public})
    return choices, public_choices


@dataclass
class Inspection:
    url: str
    title: str
    choices: dict
    created: float = field(default_factory=time.monotonic)


@dataclass
class Job:
    identifier: str
    directory: Path
    title: str
    state: str = "queued"
    percent: float | None = None
    speed: float | None = None
    error: dict | None = None
    file: Path | None = None
    expires: float | None = None
    readers: int = 0

    def public(self):
        return {
            "id": self.identifier,
            "state": self.state,
            "percent": self.percent,
            "speed": self.speed,
            "error": self.error,
            "fileUrl": f"/api/jobs/{self.identifier}/file" if self.state == "ready" else None,
        }


class VideoService:
    def __init__(self, directory):
        self.directory = directory
        self.inspections = {}
        self.jobs = {}
        self.lock = threading.Lock()
        self.inspect_slots = threading.BoundedSemaphore(3)
        self.download_slots = threading.BoundedSemaphore(2)

    def inspect(self, url):
        if not self.inspect_slots.acquire(blocking=False):
            raise UserError("正在解析其他链接，请稍后再试。", 429)
        try:
            with YoutubeDL({**engine_options(), "format": "all"}) as ydl:
                info = ydl.extract_info(url, download=False)
        except DownloadError as error:
            raise engine_error(error, "链接解析失败。请检查链接并确认视频可以公开播放。") from error
        finally:
            self.inspect_slots.release()
        if not info:
            raise UserError("未找到视频。请粘贴单个视频的播放页链接。", 422)
        rejection = reject_live_or_playlist(info)
        if rejection:
            raise UserError(rejection, 422)
        choices, public_choices = available_choices(info)
        if not choices:
            raise UserError("没有找到可下载的媒体格式。", 422)
        identifier = secrets.token_hex(16)
        title = str(info.get("title") or "视频")[:300]
        with self.lock:
            if len(self.inspections) >= 100:
                del self.inspections[next(iter(self.inspections))]
            self.inspections[identifier] = Inspection(url, title, choices)
        return {
            "id": identifier,
            "title": title,
            "source": info.get("extractor_key") or urlsplit(url).hostname,
            "uploader": info.get("uploader") or info.get("channel"),
            "duration": info.get("duration"),
            "thumbnail": media_url(info.get("thumbnail")),
            "ffmpeg": bool(FFMPEG),
            "formats": public_choices,
        }

    def start_download(self, inspection_id, format_id):
        with self.lock:
            inspection = self.inspections.get(inspection_id)
            if inspection is None or inspection.created + RETENTION <= time.monotonic():
                raise UserError("解析结果已过期，请重新解析链接。", 404)
            choice = inspection.choices.get(format_id)
            if choice is None:
                raise UserError("请选择可用的下载格式。")
            if not self.download_slots.acquire(blocking=False):
                raise UserError("已有两个下载任务在运行，请稍后再试。", 429)
            identifier = secrets.token_hex(16)
            job = Job(identifier, self.directory / identifier, inspection.title)
            self.jobs[identifier] = job
            initial = job.public()
        try:
            threading.Thread(
                target=self.run_download, args=(job, inspection.url, choice), daemon=True
            ).start()
        except RuntimeError:
            with self.lock:
                del self.jobs[identifier]
            self.download_slots.release()
            raise
        return initial

    def run_download(self, job, url, choice):
        def update(state, percent=None, speed=None):
            with self.lock:
                job.state, job.percent, job.speed = state, percent, speed

        def progress(event):
            if event["status"] == "downloading":
                total = event.get("total_bytes") or event.get("total_bytes_estimate")
                received = event.get("downloaded_bytes") or 0
                update("downloading", min(100, received * 100 / total) if total else None, event.get("speed"))
            elif event["status"] == "finished":
                update("processing")

        options = {
            **engine_options(),
            "format": choice.select,
            "merge_output_format": choice.extension,
            "paths": {"home": str(job.directory)},
            "outtmpl": {"default": "media.%(ext)s"},
            "progress_hooks": [progress],
            "skip_unavailable_fragments": False,
            "overwrites": True,
        }
        try:
            job.directory.mkdir()
            update("preparing")
            with YoutubeDL(options) as ydl:
                ydl.extract_info(url, download=True)
            files = [
                path for path in job.directory.iterdir()
                if path.is_file() and path.stem == "media" and path.suffix[1:] in MEDIA_EXTS
            ]
            if len(files) != 1 or files[0].stat().st_size == 0:
                raise UserError("没有生成下载文件。请重新解析链接后再试。", 422)
            with self.lock:
                job.file = files[0]
                job.state, job.percent, job.speed = "ready", 100, None
                job.expires = time.monotonic() + RETENTION
        except Exception as error:
            if isinstance(error, DownloadError):
                error = engine_error(error, "下载失败。请尝试重新解析或选择其他格式。")
            if not isinstance(error, UserError):
                logging.exception("Download failed")
                error = UserError("本地下载失败。请检查可用磁盘空间后重试。")
            shutil.rmtree(job.directory, ignore_errors=True)
            with self.lock:
                job.state = "failed"
                job.error = {"error": str(error), "detail": error.detail}
                job.expires = time.monotonic() + RETENTION
        finally:
            self.download_slots.release()

    def get_job(self, identifier):
        job = self.jobs.get(identifier)
        if job is None or (job.expires is not None and job.expires <= time.monotonic()):
            raise UserError("下载任务已过期，请重新下载。", 404)
        return job

    def prune(self):
        now = time.monotonic()
        with self.lock:
            self.inspections = {
                key: item for key, item in self.inspections.items() if item.created + RETENTION > now
            }
            expired = [
                key for key, job in self.jobs.items()
                if job.expires is not None and job.expires <= now and job.readers == 0
            ]
            directories = [self.jobs.pop(key).directory for key in expired]
        for directory in directories:
            shutil.rmtree(directory, ignore_errors=True)


class LocalServer(ThreadingHTTPServer):
    def __init__(self, port, service):
        super().__init__(("127.0.0.1", port), Handler)
        port = self.server_address[1]
        self.hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
        self.service = service
        self.last_prune = time.monotonic()

    def service_actions(self):
        if time.monotonic() - self.last_prune >= 30:
            self.service.prune()
            self.last_prune = time.monotonic()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        if args and len(args) >= 2 and str(args[1]).startswith("5"):
            super().log_message(format, *args)

    def do_HEAD(self):
        self.handle_request()

    def do_GET(self):
        self.handle_request()

    def do_POST(self):
        self.handle_request()

    def handle_request(self):
        try:
            host = self.headers.get("Host", "").lower()
            origin = self.headers.get("Origin")
            if host not in self.server.hosts or (origin and origin != f"http://{host}"):
                raise UserError("请从本机地址打开工具。", 403)
            path = urlsplit(self.path).path
            if self.command == "POST":
                self.post(path)
            else:
                self.get(path)
        except UserError as error:
            self.send_json({"error": str(error), "detail": error.detail}, error.status)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except Exception:
            logging.exception("Request failed")
            self.send_json({"error": "本地服务出现错误，请查看启动窗口。"}, 500)

    def post(self, path):
        if path not in {"/api/inspect", "/api/download"}:
            raise UserError("找不到该页面。", 404)
        if self.headers.get_content_type() != "application/json":
            raise UserError("请求需要 JSON 数据。", 415)
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 24000:
                raise ValueError
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                raise ValueError
        except (ValueError, UnicodeError) as error:
            raise UserError("请求数据无效。") from error
        if path == "/api/inspect":
            url = media_url(data.get("url"))
            if url is None:
                raise UserError("请输入以 http:// 或 https:// 开头的有效链接。")
            self.send_json(self.server.service.inspect(url))
            return
        inspection_id, format_id = data.get("inspectionId"), data.get("formatId")
        if not isinstance(inspection_id, str) or not isinstance(format_id, str):
            raise UserError("请先解析链接并选择格式。")
        self.send_json(self.server.service.start_download(inspection_id, format_id), 202)

    def get(self, path):
        service = self.server.service
        if path == "/api/status":
            self.send_json({"engine": YTDLP_VERSION, "ffmpeg": bool(FFMPEG)})
        elif path in STATIC:
            name, content_type = STATIC[path]
            self.send_file(ROOT / name, content_type)
        elif match := re.fullmatch(r"/api/jobs/([a-f0-9]{32})(/file)?", path):
            with service.lock:
                job = service.get_job(match[1])
                if not match[2]:
                    data = job.public()
                elif job.file is None:
                    raise UserError("文件还没有准备好。", 409)
                else:
                    job.readers += 1
            if not match[2]:
                self.send_json(data)
                return
            try:
                name = re.sub(r'[<>:"/\\|?*\x00-\x1f\x7f]', "_", job.title).strip(" .")[:100] or "video"
                filename = quote(name + job.file.suffix)
                mime = mimetypes.guess_type(job.file.name)[0] or "application/octet-stream"
                disposition = f"attachment; filename*=UTF-8''{filename}"
                self.send_file(job.file, mime, disposition)
            finally:
                with service.lock:
                    job.readers -= 1
        else:
            raise UserError("找不到该页面。", 404)

    def response(self, status, content_type, length, disposition=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' http: https:; object-src 'none'; "
            "base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        )
        if disposition:
            self.send_header("Content-Disposition", disposition)
        self.end_headers()

    def send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.response(status, "application/json; charset=utf-8", len(body))
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_file(self, path, content_type, disposition=None):
        with path.open("rb") as file:
            self.response(200, content_type, path.stat().st_size, disposition)
            if self.command != "HEAD":
                shutil.copyfileobj(file, self.wfile, length=1024 * 1024)


def main():
    parser = argparse.ArgumentParser(description="取帧 · 网页视频解析与下载")
    parser.add_argument("--port", type=int, default=8765, help="本地端口，默认 8765")
    parser.add_argument("--open", action="store_true", help="启动后打开浏览器")
    args = parser.parse_args()
    try:
        with TemporaryDirectory(prefix="quzhen-", ignore_cleanup_errors=True) as directory:
            with LocalServer(args.port, VideoService(Path(directory))) as server:
                url = f"http://127.0.0.1:{server.server_address[1]}"
                print(f"取帧已启动  {url}  (Ctrl+C 停止)", flush=True)
                if args.open:
                    webbrowser.open(url)
                server.serve_forever()
    except KeyboardInterrupt:
        pass
    except OSError as error:
        parser.exit(1, f"启动失败：{error}\n端口被占用时可用 --port 8766 重试。\n")


if __name__ == "__main__":
    main()
