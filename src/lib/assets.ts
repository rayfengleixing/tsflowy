import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";

// 图片资源地址（项目说明书 12 节风险 4：二进制存 assets/ + 相对路径入库）。
// 相对路径 "assets/xxx.png" → asset 协议 URL（依赖 tauri.conf.json 的 assetProtocol 配置）。

let dataDirPromise: Promise<string> | null = null;

export function getAppDataDir(): Promise<string> {
  if (!dataDirPromise) dataDirPromise = appDataDir();
  return dataDirPromise;
}

/** 相对路径 → 可加载的 asset URL */
export async function resolveAssetUrl(relative: string): Promise<string> {
  const dir = await getAppDataDir();
  return convertFileSrc(await join(dir, relative));
}

/**
 * 把字节流保存到 assets 目录（走 Rust save_asset_bytes 命令）。
 * 用于编辑器粘贴/拖拽图片上传：ClipboardEvent 拿到的是 Blob/File，
 * 直接传 bytes 比"先写临时文件再传路径"省事得多。
 *
 * @param bytes 字节内容
 * @param ext 扩展名（不含点），如 "png"/"jpeg"；非字母数字会被兜底为 "bin"
 * @returns 相对路径 "assets/{nanos}.{ext}"，可入库为 image 节点的 src
 */
export async function uploadImageBytes(bytes: Uint8Array, ext: string): Promise<string> {
  return await invoke<string>("save_asset_bytes", {
    bytes: Array.from(bytes),
    ext,
  });
}

/**
 * 从 File 对象（剪贴板/拖拽）抽取扩展名。
 * 优先用 file.name 的扩展名，回落到 MIME（image/png → png），最后兜底 "png"。
 */
export function pickImageExt(file: File): string {
  const dot = file.name.lastIndexOf(".");
  if (dot >= 0) {
    const e = file.name.slice(dot + 1).toLowerCase();
    if (/^[a-z0-9]{1,5}$/.test(e)) return e;
  }
  const mime = file.type.toLowerCase();
  const m = mime.match(/^image\/([a-z0-9.+-]+)/);
  if (m) return m[1];
  return "png";
}

/** 判断 File 是否为图片（用于粘贴/拖拽分流） */
export function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}
