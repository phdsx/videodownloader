"use strict";

const byId = (id) => document.getElementById(id);
const form = byId("link-form");
const input = byId("video-url");
const inspectButton = byId("inspect");
const demoButton = byId("demo");
const thumbnail = byId("thumbnail");
const filters = byId("filters");
const formats = byId("format-rows");
const jobPanel = byId("job");
const progress = byId("progress");
const saveLink = byId("save-file");
const sourceLink = byId("source-file");
const details = byId("job-details");
const webMode = ["http:", "https:"].includes(location.protocol) &&
  !["127.0.0.1", "localhost"].includes(location.hostname);
const demoFile = new URL("./demo.mp4", location.href);
const videoExtensions = new Set(["mp4", "webm", "mkv", "mov", "m4v", "avi", "flv", "3gp"]);
const audioExtensions = new Set(["m4a", "mp3", "wav", "flac", "ogg", "opus", "aac"]);
let online = false;
let inspecting = false;
let downloading = false;
let result = null;
let filter = "all";
let downloadObjectUrl = null;

async function api(path, body) {
  let response;
  try {
    response = await fetch(path, body === undefined ? {} : {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("本地服务未连接。请启动服务后刷新此页。");
  }
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || "操作失败，请重试。");
    error.detail = data.detail;
    throw error;
  }
  return data;
}

function updateControls() {
  inspectButton.disabled = demoButton.disabled = !online || inspecting || downloading;
  for (const button of formats.querySelectorAll("button")) {
    button.disabled = downloading;
  }
}

function feedback(message = "", error = false) {
  const feedback = byId("form-feedback");
  feedback.hidden = !message;
  feedback.dataset.error = String(error);
  feedback.textContent = message;
}

async function connect() {
  if (webMode) {
    online = true;
    byId("service-status").dataset.state = "ready";
    byId("service-text").textContent = "网页版 · 直链下载";
    byId("intro-text").textContent = "下载 HTTPS 视频和音频直链，或打开本地版解析视频网页。";
    byId("link-hint").textContent = "支持 MP4、WebM、MP3 等媒体文件的 HTTPS 直链。";
    byId("local-label").hidden = true;
    byId("local-launch").hidden = false;
    byId("local-guide").hidden = false;
    updateControls();
    return;
  }
  try {
    if (location.protocol === "file:") throw new Error();
    const status = await api("/api/status");
    online = true;
    byId("service-status").dataset.state = "ready";
    byId("service-text").textContent = "本地服务已连接";
    byId("service-status").title = "yt-dlp " + status.engine;
    byId("ffmpeg-note").hidden = status.ffmpeg;
    const transferred = new URLSearchParams(location.hash.slice(1)).get("url");
    if (transferred) input.value = transferred.slice(0, input.maxLength);
  } catch {
    byId("service-status").dataset.state = "offline";
    byId("service-text").textContent = "本地服务未连接";
    feedback("双击 start.cmd 启动本地服务，再使用浏览器打开服务地址。", true);
  }
  updateControls();
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const secondsTotal = Math.floor(seconds);
  const minutes = Math.floor(secondsTotal / 60);
  const parts = [minutes % 60, secondsTotal % 60];
  if (minutes >= 60) parts.unshift(Math.floor(minutes / 60));
  return parts.map((value, index) => String(value).padStart(index === 0 && parts.length === 3 ? 1 : 2, "0")).join(":");
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.max(0, Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1));
  const value = bytes / (1024 ** index);
  return value.toLocaleString("zh-CN", { maximumFractionDigits: index === 0 ? 0 : 1 }) + " " + units[index];
}

function renderPreview(item) {
  thumbnail.hidden = true;
  thumbnail.removeAttribute("src");
  byId("frame-icon").hidden = false;
  if (item?.thumbnail) thumbnail.src = item.thumbnail;
  const sources = { Generic: "网页 / 媒体直链", HTML5MediaEmbed: "网页内嵌视频" };
  const source = item ? (sources[item.source] || item.source) : null;
  byId("video-title").textContent = item?.title || "解析结果将在这里显示";
  byId("video-meta").textContent = item
    ? [source, item.uploader, formatDuration(item.duration)].filter(Boolean).join(" · ")
    : "视频标题、来源和时长";
  byId("preview-state").textContent = item ? "解析完成" : "等待解析";
}

thumbnail.addEventListener("load", () => {
  if (!thumbnail.hasAttribute("src")) return;
  thumbnail.hidden = false;
  byId("frame-icon").hidden = true;
});

thumbnail.addEventListener("error", () => {
  thumbnail.hidden = true;
  byId("frame-icon").hidden = false;
});

function mediaLabels(option) {
  if (option.kind === "audio") {
    return ["仅音频", [option.bitrate ? Math.round(option.bitrate) + " kbps" : null, option.language].filter(Boolean).join(" · ")];
  }
  const quality = option.height ? option.height + "p" : "源画质";
  const track = option.merge ? "合并音视频" : option.kind === "video-only" ? "仅视频" : "视频";
  return [quality, [track, option.fps ? option.fps + " fps" : null, option.language].filter(Boolean).join(" · ")];
}

function renderFormats() {
  const visible = result?.formats.filter((option) => {
    if (filter === "all") return true;
    return filter === "audio" ? option.kind === "audio" : option.kind !== "audio";
  }) || [];
  filters.hidden = !result;
  for (const button of filters.querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.filter === filter));
  }
  byId("format-table").hidden = visible.length === 0;
  const empty = byId("format-empty");
  empty.hidden = visible.length > 0;
  empty.querySelector("p").textContent = result
    ? (filter === "audio" ? "这个来源没有单独的音频轨道。" : "这个来源没有视频轨道。")
    : "解析链接后，可在这里选择格式并下载。";
  formats.replaceChildren();

  for (const option of visible) {
    const row = formats.insertRow();
    const quality = row.insertCell();
    const primary = document.createElement("strong");
    const secondary = document.createElement("small");
    [primary.textContent, secondary.textContent] = mediaLabels(option);
    quality.append(primary, secondary);
    const extension = option.extension.toUpperCase();
    row.insertCell().textContent = extension;
    const size = formatBytes(option.bytes);
    row.insertCell().textContent = size ? (option.estimated ? "约 " + size : size) : "未知";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button download-button";
    button.textContent = "下载";
    button.setAttribute("aria-label", "下载 " + primary.textContent + " " + extension);
    button.disabled = downloading;
    button.addEventListener("click", () => download(option.id));
    row.insertCell().append(button);
  }
}

function renderJob(state, message, percent = null, link = null, detail = null) {
  jobPanel.hidden = !state;
  jobPanel.dataset.state = state || "";
  if (byId("job-text").textContent !== message) byId("job-text").textContent = message;
  progress.hidden = !["queued", "preparing", "downloading", "processing"].includes(state);
  if (percent === null) progress.removeAttribute("value");
  else progress.value = percent;
  saveLink.hidden = !link;
  if (link) saveLink.href = link;
  else saveLink.removeAttribute("href");
  saveLink.removeAttribute("download");
  sourceLink.hidden = true;
  sourceLink.removeAttribute("href");
  details.hidden = !detail;
  if (!detail) details.open = false;
  details.querySelector("p").textContent = detail || "";
}

function updateLocalLink() {
  if (!webMode) return;
  const url = input.value.trim();
  const fragment = url ? "#" + new URLSearchParams({ url }) : "";
  byId("local-launch").href = "http://127.0.0.1:8765/" + fragment;
}

function inspectDirect(url) {
  if (url.protocol !== "https:") throw new Error("网页版需要 HTTPS 媒体直链。可打开本地版使用这个链接。");
  const filename = url.pathname.split("/").pop();
  const extension = filename.match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase();
  const kind = videoExtensions.has(extension) ? "video" : audioExtensions.has(extension) ? "audio" : null;
  if (!kind) throw new Error("请输入以 MP4、WebM、MP3 等扩展名结尾的媒体直链。网页或 M3U8 请用本地版。");
  let decoded = filename;
  try {
    decoded = decodeURIComponent(filename);
  } catch {
    // Some sources use a literal percent sign in file names.
  }
  const isDemo = url.href === demoFile.href;
  return {
    title: isDemo ? "取帧示例 · 绿色波纹" : decoded,
    source: url.hostname,
    thumbnail: isDemo ? new URL("./demo.jpg", location.href).href : null,
    directUrl: url.href,
    filename: decoded.replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, "_"),
    formats: [{ id: "direct", kind, extension }],
  };
}

function revokeDownload() {
  if (downloadObjectUrl) URL.revokeObjectURL(downloadObjectUrl);
  downloadObjectUrl = null;
}

async function inspect() {
  if (!online || inspecting || downloading) return;
  const url = input.value.trim();
  let parsed;
  try {
    parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) throw new Error();
  } catch {
    feedback("请输入以 http:// 或 https:// 开头的有效视频链接。", true);
    input.focus();
    return;
  }
  inspecting = true;
  updateLocalLink();
  updateControls();
  inspectButton.setAttribute("aria-busy", "true");
  byId("inspect-text").textContent = "正在解析…";
  feedback("正在获取视频信息。");
  result = null;
  filter = "all";
  renderPreview(null);
  byId("preview-state").textContent = "正在解析";
  renderFormats();
  renderJob(null, "");
  revokeDownload();
  try {
    result = webMode ? inspectDirect(parsed) : await api("/api/inspect", { url });
    renderPreview(result);
    renderFormats();
    const count = "找到 " + result.formats.length + " 种下载格式。";
    feedback(webMode || result.ffmpeg ? count : count + " 安装 FFmpeg 后可合并音视频。");
  } catch (error) {
    byId("preview-state").textContent = "解析失败";
    feedback(error.message, true);
    if (error.detail) renderJob("failed", "链接解析失败。", null, null, error.detail);
  } finally {
    inspecting = false;
    inspectButton.removeAttribute("aria-busy");
    byId("inspect-text").textContent = "解析视频";
    updateControls();
  }
}

async function downloadDirect(item) {
  revokeDownload();
  try {
    let saveUrl = item.directUrl;
    if (new URL(saveUrl).origin !== location.origin) {
      renderJob("downloading", "正在读取源站文件…");
      const response = await fetch(saveUrl, { credentials: "omit", referrerPolicy: "no-referrer" });
      if (!response.ok) throw new Error("源站返回 HTTP " + response.status + "，请检查链接。");
      if (response.headers.get("Content-Type")?.startsWith("text/html")) {
        throw new Error("源站返回了网页。请使用媒体直链，或打开本地版解析。");
      }
      const blob = await response.blob();
      if (!blob.size) throw new Error("源站文件为空。");
      saveUrl = downloadObjectUrl = URL.createObjectURL(blob);
    }
    renderJob("ready", "文件已准备好。", null, saveUrl);
    saveLink.download = item.filename;
    saveLink.click();
  } catch (error) {
    const message = error instanceof TypeError
      ? "浏览器无法读取源站文件。可打开原始链接，或用本地版下载。"
      : error.message;
    renderJob("failed", message);
    sourceLink.href = item.directUrl;
    sourceLink.hidden = false;
  }
}

async function download(formatId) {
  if (downloading || !result) return;
  downloading = true;
  updateControls();
  renderJob("queued", "正在创建下载任务…");
  try {
    if (webMode) {
      await downloadDirect(result);
      return;
    }
    let job = await api("/api/download", { inspectionId: result.id, formatId });
    const url = "/api/jobs/" + encodeURIComponent(job.id);
    const labels = {
      queued: "正在创建下载任务…",
      preparing: "正在连接视频来源…",
      downloading: "正在下载当前媒体轨道",
      processing: "正在处理媒体文件…",
    };
    while (labels[job.state]) {
      const percent = job.percent === null ? "" : " · " + Math.floor(job.percent) + "%";
      const speed = formatBytes(job.speed);
      renderJob(job.state, labels[job.state] + percent + (speed ? " · " + speed + "/s" : ""), job.percent);
      await new Promise((resolve) => setTimeout(resolve, 650));
      job = await api(url);
    }
    if (job.state !== "ready" || !job.fileUrl) {
      renderJob("failed", job.error?.error || "下载失败，请重试。", null, null, job.error?.detail);
      return;
    }
    renderJob("ready", "文件已准备好。", null, job.fileUrl);
    saveLink.click();
  } catch (error) {
    renderJob("failed", error.message, null, null, error.detail);
  } finally {
    downloading = false;
    updateControls();
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  inspect();
});

byId("paste").addEventListener("click", async () => {
  input.focus();
  try {
    const text = (await navigator.clipboard.readText()).trim();
    if (text) {
      input.value = text.slice(0, input.maxLength);
      updateLocalLink();
    }
    else if (online) feedback("剪贴板没有文本，可以手动粘贴链接。");
  } catch {
    if (online) feedback("浏览器未允许读取剪贴板。可以用 Ctrl+V 或 ⌘V 粘贴链接。");
  }
});

demoButton.addEventListener("click", () => {
  input.value = webMode ? demoFile.href : new URL("/demo", location.href).href;
  inspect();
});

filters.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-filter]");
  if (!button) return;
  filter = button.dataset.filter;
  renderFormats();
});

input.addEventListener("input", updateLocalLink);

connect();
