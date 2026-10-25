import type { AttachmentType } from "@theopenbee/channel-sdk";

const SNIFF_LEN = 512;

type Matcher = (data: Uint8Array, firstNonWS: number) => string;

function bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function isWS(b: number): boolean {
  return b === 0x09 || b === 0x0a || b === 0x0c || b === 0x0d || b === 0x20;
}

function isTagTerminator(b: number): boolean {
  return b === 0x20 || b === 0x3e;
}

function exact(sig: string, ct: string): Matcher {
  const pat = bytes(sig);
  return (data) => {
    if (data.length < pat.length) return "";
    for (let i = 0; i < pat.length; i++) if (data[i] !== pat[i]) return "";
    return ct;
  };
}

function masked(mask: string, pattern: string, ct: string, skipWS = false): Matcher {
  const m = bytes(mask);
  const pat = bytes(pattern);
  return (input, firstNonWS) => {
    const data = skipWS ? input.subarray(firstNonWS) : input;
    if (pat.length !== m.length || data.length < pat.length) return "";
    for (let i = 0; i < pat.length; i++) if ((data[i] & m[i]) !== pat[i]) return "";
    return ct;
  };
}

function html(sig: string): Matcher {
  const pat = bytes(sig);
  return (input, firstNonWS) => {
    const data = input.subarray(firstNonWS);
    if (data.length < pat.length + 1) return "";
    for (let i = 0; i < pat.length; i++) {
      const b = pat[i];
      let db = data[i];
      if (b >= 0x41 && b <= 0x5a) db &= 0xdf;
      if (b !== db) return "";
    }
    if (!isTagTerminator(data[pat.length])) return "";
    return "text/html; charset=utf-8";
  };
}

const mp4: Matcher = (data) => {
  if (data.length < 12) return "";
  const boxSize = ((data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3]) >>> 0;
  if (data.length < boxSize || boxSize % 4 !== 0) return "";
  if (data[4] !== 0x66 || data[5] !== 0x74 || data[6] !== 0x79 || data[7] !== 0x70) return "";
  for (let st = 8; st < boxSize; st += 4) {
    if (st === 12) continue;
    if (data[st] === 0x6d && data[st + 1] === 0x70 && data[st + 2] === 0x34) return "video/mp4";
  }
  return "";
};

const text: Matcher = (data, firstNonWS) => {
  for (let i = firstNonWS; i < data.length; i++) {
    const b = data[i];
    if (b <= 0x08 || b === 0x0b || (b >= 0x0e && b <= 0x1a) || (b >= 0x1c && b <= 0x1f)) return "";
  }
  return "text/plain; charset=utf-8";
};

const NUL34 = "\x00".repeat(34);

const SIGNATURES: Matcher[] = [
  html("<!DOCTYPE HTML"),
  html("<HTML"),
  html("<HEAD"),
  html("<SCRIPT"),
  html("<IFRAME"),
  html("<H1"),
  html("<DIV"),
  html("<FONT"),
  html("<TABLE"),
  html("<A"),
  html("<STYLE"),
  html("<TITLE"),
  html("<B"),
  html("<BODY"),
  html("<BR"),
  html("<P"),
  html("<!--"),
  masked("\xFF\xFF\xFF\xFF\xFF", "<?xml", "text/xml; charset=utf-8", true),
  exact("%PDF-", "application/pdf"),
  exact("%!PS-Adobe-", "application/postscript"),
  masked("\xFF\xFF\x00\x00", "\xFE\xFF\x00\x00", "text/plain; charset=utf-16be"),
  masked("\xFF\xFF\x00\x00", "\xFF\xFE\x00\x00", "text/plain; charset=utf-16le"),
  masked("\xFF\xFF\xFF\x00", "\xEF\xBB\xBF\x00", "text/plain; charset=utf-8"),
  exact("\x00\x00\x01\x00", "image/x-icon"),
  exact("\x00\x00\x02\x00", "image/x-icon"),
  exact("BM", "image/bmp"),
  exact("GIF87a", "image/gif"),
  exact("GIF89a", "image/gif"),
  masked("\xFF\xFF\xFF\xFF\x00\x00\x00\x00\xFF\xFF\xFF\xFF\xFF\xFF", "RIFF\x00\x00\x00\x00WEBPVP", "image/webp"),
  exact("\x89PNG\x0D\x0A\x1A\x0A", "image/png"),
  exact("\xFF\xD8\xFF", "image/jpeg"),
  masked("\xFF\xFF\xFF\xFF\x00\x00\x00\x00\xFF\xFF\xFF\xFF", "FORM\x00\x00\x00\x00AIFF", "audio/aiff"),
  masked("\xFF\xFF\xFF", "ID3", "audio/mpeg"),
  masked("\xFF\xFF\xFF\xFF\xFF", "OggS\x00", "application/ogg"),
  masked("\xFF\xFF\xFF\xFF\xFF\xFF\xFF\xFF", "MThd\x00\x00\x00\x06", "audio/midi"),
  masked("\xFF\xFF\xFF\xFF\x00\x00\x00\x00\xFF\xFF\xFF\xFF", "RIFF\x00\x00\x00\x00AVI ", "video/avi"),
  masked("\xFF\xFF\xFF\xFF\x00\x00\x00\x00\xFF\xFF\xFF\xFF", "RIFF\x00\x00\x00\x00WAVE", "audio/wave"),
  mp4,
  exact("\x1A\x45\xDF\xA3", "video/webm"),
  masked(NUL34 + "\xFF\xFF", NUL34 + "LP", "application/vnd.ms-fontobject"),
  exact("\x00\x01\x00\x00", "font/ttf"),
  exact("OTTO", "font/otf"),
  exact("ttcf", "font/collection"),
  exact("wOFF", "font/woff"),
  exact("wOF2", "font/woff2"),
  exact("\x1F\x8B\x08", "application/x-gzip"),
  exact("PK\x03\x04", "application/zip"),
  exact("Rar!\x1A\x07\x00", "application/x-rar-compressed"),
  exact("Rar!\x1A\x07\x01\x00", "application/x-rar-compressed"),
  exact("\x00asm", "application/wasm"),
  text,
];

export function detectContentType(input: Uint8Array): string {
  const data = input.length > SNIFF_LEN ? input.subarray(0, SNIFF_LEN) : input;
  let firstNonWS = 0;
  while (firstNonWS < data.length && isWS(data[firstNonWS])) firstNonWS++;
  for (const match of SIGNATURES) {
    const ct = match(data, firstNonWS);
    if (ct) return ct;
  }
  return "application/octet-stream";
}

export function fileExt(name: string): string {
  for (let i = name.length - 1; i >= 0 && name[i] !== "/" && name[i] !== "\\"; i--) {
    if (name[i] === ".") return name.slice(i);
  }
  return "";
}

const mimeByExtension: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
};

export function mimeFromExtension(ext: string): string {
  return mimeByExtension[ext.toLowerCase()] ?? "application/octet-stream";
}

export function detectMime(data: Uint8Array, fileName: string): string {
  if (data.length >= 4 && data[0] === 0x4f && data[1] === 0x67 && data[2] === 0x67 && data[3] === 0x53) return "audio/ogg";
  if (data.length > 0) {
    const ct = detectContentType(data);
    if (ct !== "application/octet-stream" && ct !== "text/plain; charset=utf-8") return ct;
  }
  if (fileName) return mimeFromExtension(fileExt(fileName));
  if (data.length > 0) return detectContentType(data);
  return "application/octet-stream";
}

function baseType(contentType: string): string {
  return contentType.split(";")[0].trim();
}

const extensionByMime: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/tiff": ".tiff",
  "image/x-icon": ".ico",
  "image/vnd.microsoft.icon": ".ico",
  "audio/ogg": ".ogg",
  "audio/opus": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/amr": ".amr",
  "audio/aac": ".aac",
  "audio/flac": ".flac",
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/x-msvideo": ".avi",
  "application/pdf": ".pdf",
};

export function extensionFromMime(contentType: string): string {
  return extensionByMime[baseType(contentType)] ?? ".bin";
}

export function mediaTypeFromMime(contentType: string): AttachmentType {
  const ct = baseType(contentType);
  if (ct.startsWith("image/")) return "image";
  if (ct.startsWith("audio/")) return "audio";
  if (ct.startsWith("video/")) return "video";
  return "document";
}
