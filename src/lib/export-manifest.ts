/** 整库导出文件夹根目录里的引用清单文件名 */
export const EXPORT_MANIFEST_FILE = ".tsflowy-export.json";

/**
 * 跨库引用清单：正文里的跨页引用写的是**导出那个库的 viewId**（`@[标题](view:id)`、
 * `→[表名](db:id)`），这些 id 到了别的库里什么都不是。导出时记一份 viewId → 相对路径，
 * 导入端建完页面后按路径把引用接回新生成的 id。
 */
export interface ExportManifest {
  version: 1;
  views: Record<string, string>;
}

/** 读不到、解析失败或不是本 App 写的清单都按「没有清单」处理，导入照常进行（只退化为按标题匹配） */
export function parseExportManifest(raw: string): ExportManifest | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const rec = parsed as { version?: unknown; views?: unknown };
    if (rec.version !== 1 || typeof rec.views !== "object" || rec.views === null) return null;
    const views: Record<string, string> = {};
    for (const [id, relPath] of Object.entries(rec.views as Record<string, unknown>)) {
      if (typeof relPath === "string") views[id] = relPath;
    }
    return { version: 1, views };
  } catch {
    return null;
  }
}
