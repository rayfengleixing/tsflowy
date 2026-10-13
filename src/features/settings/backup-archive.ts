/** list_backups 返回的备份归档（Rust 侧字段名即 JSON 键名） */
export interface BackupArchive {
  name: string;
  size: number;
  /** 修改时间（本地时间串，Rust 侧已格式化好） */
  modified: string;
  /** 修改时间（epoch 毫秒） */
  mtime_ms: number;
}

/**
 * 展示顺序：新→旧。Rust 侧已按 mtime 排好，这里再排一次只为纯函数可测 + 防御后端改动。
 * 只按 mtime_ms 排：auto-*.zip 与 tsflowy-backup-*.zip 两种命名混排时字典序 ≠ 时间序。
 */
export function sortBackupArchives(items: BackupArchive[]): BackupArchive[] {
  return [...items].sort((a, b) => b.mtime_ms - a.mtime_ms);
}
