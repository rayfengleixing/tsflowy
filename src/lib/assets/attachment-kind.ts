// 附件类型判定：只看扩展名。编辑器 NodeView 与 HTML 导出共用这一份名单，
// 免得出现「编辑器里能播、导出的 HTML 变成下载链接」两套口径。
// 纯逻辑（不碰 Tauri API），所以 src/lib/assets.ts 反过来 import 这里的图片扩展名。

export type AttachmentKind = "image" | "audio" | "video" | "pdf" | "other";

/** WebView2（Chromium）能直接显示的图片扩展名 */
export const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "ico"]);

/** 能直接 <audio controls> 播的容器/编码 */
const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "oga", "opus", "m4a", "aac", "flac"]);

/** 能直接 <video controls> 播的容器（avi/mkv/flv 这类 Chromium 不认的一律归 other，宁可给下载链接也别给个报错的黑框） */
const VIDEO_EXTS = new Set(["mp4", "m4v", "webm", "mov", "ogv"]);

/** 从名字取扩展名（小写、1–5 位字母数字），取不到返回 null */
export function extOfName(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,5}$/.test(ext) ? ext : null;
}

/**
 * 按候选名依次判定：先文件名（用户看得见的那个），拿不准再看相对路径。
 * 空串、无扩展名、未知扩展名都算 "other"，走原来的下载/打开卡片。
 */
export function attachmentKindOf(...candidates: (string | null | undefined)[]): AttachmentKind {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const ext = extOfName(candidate);
    if (!ext) continue;
    if (IMAGE_EXTS.has(ext)) return "image";
    if (AUDIO_EXTS.has(ext)) return "audio";
    if (VIDEO_EXTS.has(ext)) return "video";
    if (ext === "pdf") return "pdf";
    return "other";
  }
  return "other";
}
