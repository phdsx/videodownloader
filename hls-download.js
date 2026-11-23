import "./vendor/m3u8-parser.js";

const { Parser } = globalThis.m3u8Parser;
const packedAudio = new Set(["aac", "mp3", "ac3", "ec3"]);
const mediaTypes = {
  ts: "video/mp2t", mp4: "video/mp4", m4a: "audio/mp4",
  aac: "audio/aac", mp3: "audio/mpeg", ac3: "audio/ac3", ec3: "audio/eac3",
};
const unsupported = "这条清单需要本地版处理，网页版支持未加密、分片连续的点播。";

function mediaUrl(uri, base) {
  const url = new URL(uri, base);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("网页版需要 HTTPS 清单和分片地址。请用本地版处理此链接。");
  }
  return url.href;
}

async function getResource(url, headers) {
  let response;
  try {
    response = await fetch(url, { headers, credentials: "omit", referrerPolicy: "no-referrer" });
  } catch {
    throw new Error("浏览器无法读取清单或分片。源站可能限制跨域读取，可用本地版下载。");
  }
  if (!response.ok) throw new Error("源站返回 HTTP " + response.status + "。请检查链接是否仍然有效。");
  if (response.headers.get("Content-Type")?.toLowerCase().startsWith("text/html")) {
    throw new Error("源站返回了网页，请检查 M3U8 地址。");
  }
  return response;
}

async function readPlaylist(uri, mainDefinitions) {
  const response = await getResource(uri);
  const url = mediaUrl(response.url || uri);
  const data = (await response.text()).trimStart();
  if (!/^#EXTM3U\s*(?:\r?\n|$)/.test(data)) throw new Error("链接没有返回有效的 M3U8 清单。");
  if (/^#EXT-X-(?:SESSION-KEY|I-FRAMES-ONLY|GAP|SKIP)\b/m.test(data) ||
      /^#EXT-X-KEY:(?![^\r\n]*\bMETHOD=NONE(?:[,\r\n]|$))/m.test(data)) {
    throw new Error(unsupported);
  }
  const parser = new Parser({ url, mainDefinitions });
  parser.push(data);
  parser.end();
  return { url, manifest: parser.manifest };
}

function getPart(item, base) {
  if (!item.uri) throw new Error("M3U8 缺少分片地址。");
  const url = mediaUrl(item.uri, base);
  const range = item.byterange;
  if (!range) return { url };
  const { offset, length } = range;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) ||
      length <= 0 || !Number.isSafeInteger(offset + length)) {
    throw new Error("M3U8 分片的字节范围无效。");
  }
  return { url, offset, length };
}

function samePart(first, second) {
  return first?.url === second?.url && first?.offset === second?.offset && first?.length === second?.length;
}

function extensionOf(url) {
  return new URL(url).pathname.match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase();
}

function planDownload({ manifest, url }, kind) {
  const segments = manifest.segments || [];
  if (!manifest.endList) throw new Error("这条 M3U8 尚未结束。请使用完整的点播清单。");
  if (!segments.length) throw new Error("M3U8 清单里没有可下载的分片。");

  const init = segments[0].map ? getPart(segments[0].map, url) : null;
  const parts = init ? [init] : [];
  for (const segment of segments) {
    if (segment.discontinuity || segment.key || manifest.contentProtection) throw new Error(unsupported);
    const map = segment.map ? getPart(segment.map, url) : null;
    if (!samePart(init, map)) throw new Error(unsupported);
    parts.push(getPart(segment, url));
  }
  const segmentExtension = extensionOf(parts[init ? 1 : 0].url);
  const kindHint = packedAudio.has(segmentExtension) || segmentExtension === "m4a" ? "audio" : kind;
  let extension = "ts";
  if (init && extensionOf(init.url) !== "ts") extension = kindHint === "audio" ? "m4a" : "mp4";
  if (!init && packedAudio.has(segmentExtension)) extension = segmentExtension;
  const duration = segments.reduce((sum, segment) => sum + (segment.duration || 0), 0);
  const bytes = parts.every((part) => part.length)
    ? parts.reduce((sum, part) => sum + part.length, 0)
    : null;
  return { kind: kindHint, parts, extension, duration, bytes };
}

function getRenditions({ manifest }) {
  const choices = [];
  const audioGroups = manifest.mediaGroups?.AUDIO || {};
  const seenAudio = new Set();
  for (const playlist of manifest.playlists || []) {
    if (!playlist.uri) continue;
    const attributes = playlist.attributes || {};
    const group = Object.values(audioGroups[attributes.AUDIO] || {});
    const codecs = attributes.CODECS?.split(",").map((codec) => codec.trim()) || [];
    const audioOnly = codecs.length && codecs.every((codec) => /^(?:mp4a|ac-3|ec-3|opus|flac)(?:\.|$)/i.test(codec));
    const separateAudio = group.length && group.every((track) => track.uri);
    choices.push({
      uri: playlist.uri,
      kind: audioOnly ? "audio" : separateAudio ? "video-only" : "video",
      height: attributes.RESOLUTION?.height,
      fps: attributes["FRAME-RATE"],
      bitrate: (attributes["AVERAGE-BANDWIDTH"] || attributes.BANDWIDTH) / 1000,
    });
    for (const [name, track] of Object.entries(audioGroups[attributes.AUDIO] || {})) {
      if (!track.uri || seenAudio.has(track.uri)) continue;
      seenAudio.add(track.uri);
      choices.push({ uri: track.uri, kind: "audio", language: track.language || name });
    }
  }
  return choices;
}

export async function inspectHls(uri) {
  const playlist = await readPlaylist(mediaUrl(uri));
  const renditions = getRenditions(playlist);
  const formats = [];
  let firstError;
  let skipped = 0;
  if (!renditions.length) {
    formats.push({ id: "1", ...planDownload(playlist, "video") });
  } else {
    for (let index = 0; index < renditions.length; index += 4) {
      const batch = await Promise.allSettled(renditions.slice(index, index + 4).map(async (rendition) => {
        const url = mediaUrl(rendition.uri, playlist.url);
        const track = await readPlaylist(url, playlist.manifest.definitions);
        return { ...rendition, ...planDownload(track, rendition.kind) };
      }));
      for (const entry of batch) {
        if (entry.status === "fulfilled") formats.push(entry.value);
        else {
          firstError ||= entry.reason;
          skipped++;
        }
      }
    }
    if (!formats.length) throw firstError;
    formats.sort((a, b) => (a.kind === "audio") - (b.kind === "audio") ||
      (b.height || 0) - (a.height || 0) || (b.bitrate || 0) - (a.bitrate || 0));
    formats.forEach((format, index) => { format.id = String(index + 1); });
  }
  return { formats, duration: formats[0].duration, skipped };
}

async function downloadPart(part, wholeFiles) {
  if (part.length && wholeFiles.has(part.url)) {
    return slicePart(wholeFiles.get(part.url), part);
  }
  const headers = part.length
    ? { Range: "bytes=" + part.offset + "-" + (part.offset + part.length - 1) }
    : undefined;
  const response = await getResource(part.url, headers);
  let blob;
  try {
    blob = await response.blob();
  } catch {
    throw new Error("读取视频分片中断，请重试。");
  }
  if (!blob.size) throw new Error("源站返回了空分片，请检查链接后重试。");
  if (!part.length) return blob;
  if (response.status === 200) {
    wholeFiles.set(part.url, blob);
    return slicePart(blob, part);
  }
  if (response.status !== 206 || blob.size !== part.length) {
    throw new Error("源站返回的分片字节数有误，下载已停止。");
  }
  return blob;
}

function slicePart(blob, { offset, length }) {
  if (offset + length > blob.size) throw new Error("提供的媒体文件不包含清单指定的字节范围。");
  return blob.slice(offset, offset + length);
}

export async function downloadHls(format, onProgress) {
  const { parts, extension } = format;
  const wholeFiles = new Map();
  const blobs = [await downloadPart(parts[0], wholeFiles)];
  onProgress(1, parts.length);
  for (let index = 1; index < parts.length; index += 4) {
    const batch = parts.slice(index, index + 4);
    blobs.push(...await Promise.all(batch.map((part) => downloadPart(part, wholeFiles))));
    onProgress(blobs.length, parts.length);
  }
  return new Blob(blobs, { type: mediaTypes[extension] });
}
