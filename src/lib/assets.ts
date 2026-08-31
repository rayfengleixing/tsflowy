import { convertFileSrc } from "@tauri-apps/api/core";
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
