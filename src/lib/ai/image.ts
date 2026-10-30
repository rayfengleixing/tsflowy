// 视觉输入：附件图片的白名单、上限、压缩与落盘。

import { uploadImageBytes } from "@/lib/assets/assets";

/* ————— 视觉输入：图片附件 ————— */

/** 支持的图片扩展名 → MIME；需与 Rust 侧 image_media_type 的白名单保持一致 */
export const AI_IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** 一条消息最多几张图 / 单张最多多少字节（与 Rust 内联校验一致） */
export const MAX_AI_IMAGES = 4;
export const MAX_AI_IMAGE_BYTES = 6 * 1024 * 1024;

/** 视觉模型普遍把输入缩到 1–1.5k 像素，再大的边长只是白占请求体 */
const IMAGE_MAX_EDGE = 1568;
/** 小图不重编码：省一次解码，也避免把无损截图压糊 */
const IMAGE_PASSTHROUGH_BYTES = 512 * 1024;
/** gif 重编码会丢掉动画，只缩静态图 */
const SHRINKABLE = new Set(["image/png", "image/jpeg", "image/webp"]);

/** 一张待发送的图片：只存 assets/ 相对路径，会话 JSON 因此保持很小 */
export interface AiImageAttachment {
  name: string;
  path: string;
}

/** 从文件名或 MIME 取受支持的扩展名；都不认时返回 null */
function aiImageExt(name: string, mime: string): string | null {
  const dot = name.lastIndexOf(".");
  const fromName = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (fromName in AI_IMAGE_MIME_BY_EXT) return fromName;
  const lower = mime.toLowerCase();
  return Object.entries(AI_IMAGE_MIME_BY_EXT).find(([, m]) => m === lower)?.[0] ?? null;
}

/**
 * 把大图缩到视觉模型真正吃得下的分辨率。各家接口都会把输入下采样，原图越大只是请求体越胖，
 * 而带图的这条消息在 agent 多步循环里每轮都要重发一次。
 * 小图、动图（gif）和解码失败的情况一律原样返回。
 */
async function downscaleImage(bytes: Uint8Array, mime: string): Promise<Uint8Array> {
  if (bytes.length <= IMAGE_PASSTHROUGH_BYTES || !SHRINKABLE.has(mime)) return bytes;
  try {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
    const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    if (scale >= 1) {
      bitmap.close();
      return bytes;
    }
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      return bytes;
    }
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    // 保持原格式重编码，扩展名与 MIME 不必跟着改
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime));
    if (!blob || blob.size >= bytes.length) return bytes;
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    return bytes;
  }
}

/**
 * 剪贴板 / 文件选择得到的图片 → 存进 assets/ 并返回附件引用。
 * 类型或体积不合要求就地抛错：让用户当场看到原因，比发到服务商那边才失败好，
 * 也比静默丢掉图片好（用户明确附了图）。
 */
export async function saveAiImageFile(file: File): Promise<AiImageAttachment> {
  const ext = aiImageExt(file.name, file.type);
  if (!ext) throw new Error(`不支持的图片格式：${file.name || file.type || "未命名图片"}`);
  if (file.size > MAX_AI_IMAGE_BYTES) {
    const mb = Math.round(MAX_AI_IMAGE_BYTES / 1024 / 1024);
    throw new Error(`图片太大（${(file.size / 1024 / 1024).toFixed(1)} MB），单张上限 ${mb} MB`);
  }
  const mime = AI_IMAGE_MIME_BY_EXT[ext];
  const raw = new Uint8Array(await file.arrayBuffer());
  const path = await uploadImageBytes(await downscaleImage(raw, mime), ext);
  return { name: file.name.trim() || `图片.${ext}`, path };
}
