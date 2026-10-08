import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import type { AttachmentRef } from "@/types/database";

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
  const m = /^image\/([a-z0-9.+-]+)/.exec(mime);
  if (m) return m[1];
  return "png";
}

/* ————— 附件上传 / 打开 ————— */

/** 从文件路径取原始文件名（Windows 反斜杠 / POSIX 斜杠都兼容） */
function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/**
 * 选文件 → save_asset 复制进 assets/ → 返回附件引用（原始名 + 相对路径）。
 * 用户取消或失败返回 null（调用方决定是否提示）。
 */
export async function pickAttachment(): Promise<AttachmentRef | null> {
  const selected = await open({ multiple: false });
  if (typeof selected !== "string") return null;
  const relative = await invoke<string>("save_asset", { sourcePath: selected });
  return { name: baseName(selected), path: relative };
}

/** 用系统默认程序打开 assets/ 下的附件（路径越权校验在 Rust 侧） */
export async function openAttachment(relative: string): Promise<void> {
  await invoke("open_asset", { relative });
}

/* ————— 未引用资源扫描 / 回收 ————— */

export interface OrphanAsset {
  name: string;
  bytes: number;
}

export interface OrphanScan {
  files: OrphanAsset[];
  total_files: number;
  total_bytes: number;
}

export interface OrphanPurge {
  /** 实际挪走的文件数（可能少于请求数：期间又被引用的不动） */
  moved: number;
  freed_bytes: number;
  /** 挪到的备份目录，反悔时从这里找回 */
  dest: string;
}

/** 扫描 assets/ 下不再被任何文档或页面封面引用的文件（只读，不动磁盘） */
export async function scanOrphanAssets(): Promise<OrphanScan> {
  return await invoke<OrphanScan>("scan_orphan_assets");
}

/**
 * 把未引用资源挪进备份目录（不是删除）。
 * @param names 要清理的文件名；传空数组 = 清理当前扫描出的全部孤儿资源
 */
export async function purgeOrphanAssets(names: string[]): Promise<OrphanPurge> {
  return await invoke<OrphanPurge>("purge_orphan_assets", { names });
}
