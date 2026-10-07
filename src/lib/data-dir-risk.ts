// 数据目录风险检测（设置页提示用）。
// 两种会把 SQLite 库写坏的真实用法：
// 1) 把数据目录放进云同步盘（OneDrive/坚果云/Dropbox 等），客户端会在写入中途搬走 db/-wal/-shm；
// 2) 同步文件夹与数据目录互相嵌套，同步拷贝的正是本机正在写的库。
// 只做提示，不阻止操作（用户可能清楚自己在做什么）。

/** 路径统一成小写正斜杠，便于做前缀包含判断 */
function normalize(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
}

/** 常见云同步盘的目录名（小写）；中文名按原样，拉丁名在同层目录上匹配避免 omega 误报 */
const CLOUD_MARKERS = [
  "onedrive",
  "dropbox",
  "google drive",
  "googledrive",
  "icloud",
  "nutstore",
  "坚果云",
  "baidunetdisk",
  "百度网盘",
  "mega",
  "pcloud",
  "yandexdisk",
  "syncthing",
];

/** 标记是否出现在路径的某一段开头（`/onedrive - 个人/x` 命中，`/megaphone/x` 不命中） */
function hasCloudMarker(path: string): boolean {
  return CLOUD_MARKERS.some((m) => {
    const idx = path.indexOf(m);
    if (idx < 0) return false;
    const before = idx === 0 ? "/" : path[idx - 1];
    const afterIdx = idx + m.length;
    const after = afterIdx >= path.length ? "/" : path[afterIdx];
    return (before === "/" || before === " ") && (after === "/" || after === " ");
  });
}

export type DataDirRisk = "cloud" | "sync-overlap";

/**
 * 判断数据目录的风险类型：互相嵌套优先于云盘提示（前者是配置错误，更要紧）。
 * 返回 null 表示未发现风险。
 */
export function detectDataDirRisk(dataDir: string, syncDir?: string | null): DataDirRisk | null {
  const d = normalize(dataDir);
  if (!d) return null;
  const s = normalize(syncDir ?? "");
  if (s && (d === s || d.startsWith(`${s}/`) || s.startsWith(`${d}/`))) return "sync-overlap";
  return hasCloudMarker(d) ? "cloud" : null;
}
