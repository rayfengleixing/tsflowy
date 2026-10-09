import { useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { readDir, type DirEntry } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { toast } from "sonner";
import type { FieldType } from "@/types/database";
import { resolveAttachmentNames } from "@/lib/csv";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { t, type MessageKey } from "@/lib/i18n";
import { logger } from "@/lib/logger";

// CSV 导入前的字段类型确认对话框（说明书 10-M4）：列出每列，用户可改类型；
// 附件列需额外选一个文件夹，按文件名把 CSV 里的候选名映射到磁盘文件。

/** 导入时可选的字段类型：能从文本直接还原的类型。
 *  选项类（single_select / multi_select）由调用方按列值收集去重后预置 options（见 runImportCsv），
 *  不再把选项名当 id 存；
 *  公式 / 关联 / 反向关系 / 汇总 / 创建时间 / 最后编辑时间这类派生或系统字段无法从文本反推，
 *  在类型下拉里以禁用项呈现，说明原因。 */
const IMPORT_TYPES: FieldType[] = ["text", "number", "date", "single_select", "multi_select", "checkbox", "attachment"];

/** 禁用项 → 不可导入的原因 i18n key */
const DISABLED_IMPORT_TYPES: Partial<Record<FieldType, MessageKey>> = {
  formula: "csv.typeDisabled.formula",
  relation: "csv.typeDisabled.relation",
  rollup: "csv.typeDisabled.rollup",
  reverse_relation: "csv.typeDisabled.reverse",
  created_at: "csv.typeDisabled.system",
  last_edited_at: "csv.typeDisabled.system",
};

const ALL_TYPE_ORDER: FieldType[] = [
  ...IMPORT_TYPES,
  "formula",
  "relation",
  "rollup",
  "reverse_relation",
  "created_at",
  "last_edited_at",
];

/** 递归收集目录下所有文件的小写文件名 → 绝对路径（同名取先遇到的；只收文件；子目录读取失败跳过不抛错） */
async function scanFilesRecursive(dir: string, out: Map<string, string>): Promise<void> {
  let entries: DirEntry[];
  try {
    entries = await readDir(dir);
  } catch (e) {
    logger.warn("csv-import.scan", "readDir failed", dir, e);
    return;
  }
  for (const entry of entries) {
    if (!entry.name) continue;
    const full = await join(dir, entry.name);
    if (entry.isDirectory) {
      await scanFilesRecursive(full, out);
    } else if (entry.isFile) {
      const key = entry.name.toLowerCase();
      if (!out.has(key)) out.set(key, full);
    }
  }
}

export interface CsvImportDialogProps {
  /** 列头（planImport 消歧后的名字） */
  headers: string[];
  /** 推断出的初始类型，用户可在对话框里改 */
  initialTypes: FieldType[];
  /** CSV 数据行（不含表头），用于实时计算附件列匹配统计 */
  dataRows: string[][];
  /** 取消：整件事中止，不建视图 */
  onCancel: () => void;
  /** 确认导入：回传最终类型，以及每个附件列所选文件夹的文件索引（列下标 → 小写文件名 → 绝对路径） */
  onConfirm: (types: FieldType[], foldersByColumn: Record<number, Record<string, string>>) => void;
}

/** 导入选项对话框：逐列确认类型；附件列可选文件夹看匹配统计 */
export function CsvImportDialog({ headers, initialTypes, dataRows, onCancel, onConfirm }: CsvImportDialogProps) {
  const [types, setTypes] = useState<FieldType[]>(initialTypes);
  // 每个附件列各选一个文件夹：列下标 → { 文件夹名, 小写文件名 → 绝对路径 }
  const [folders, setFolders] = useState<Record<number, { name: string; files: Record<string, string> } | undefined>>(
    {},
  );

  const setType = (col: number, type: FieldType) => setTypes((prev) => prev.map((x, i) => (i === col ? type : x)));

  const pickFolder = async (col: number) => {
    // recursive: true 让 dialog 把整棵子树写进 fs scope，子目录里的文件才能被 readDir 读到
    const selected = await open({ directory: true, multiple: false, recursive: true });
    if (typeof selected !== "string" || !selected) return;
    try {
      const map = new Map<string, string>();
      await scanFilesRecursive(selected, map);
      const name = selected.split(/[\\/]/).filter(Boolean).pop() ?? selected;
      setFolders((prev) => ({ ...prev, [col]: { name, files: Object.fromEntries(map) } }));
    } catch (e) {
      logger.error("csv import scan folder failed", e);
      toast.error(t("csv.attachment.scanFailed", { message: String(e) }));
    }
  };

  // 每个附件列的匹配统计（跨整列去重，实时反映当前列值与所选文件夹的匹配结果）
  const stats = useMemo(() => {
    const out: Record<number, { matched: number; missing: number } | undefined> = {};
    types.forEach((type, col) => {
      if (type !== "attachment") return;
      const files = folders[col]?.files ?? {};
      const matched = new Set<string>();
      const missing = new Set<string>();
      for (const row of dataRows) {
        const r = resolveAttachmentNames(row[col] ?? "", files);
        for (const m of r.matched) matched.add(m.name.toLowerCase());
        for (const m of r.missing) missing.add(m.toLowerCase());
      }
      out[col] = { matched: matched.size, missing: missing.size };
    });
    return out;
  }, [types, dataRows, folders]);

  const confirm = () => {
    const foldersByColumn: Record<number, Record<string, string>> = {};
    for (const [col, v] of Object.entries(folders)) if (v) foldersByColumn[Number(col)] = v.files;
    onConfirm(types, foldersByColumn);
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onCancel();
      }}
    >
      <DialogContent className="w-[560px] max-w-[calc(100%-2rem)]">
        <DialogHeader>
          <DialogTitle>{t("csv.importOptionsTitle")}</DialogTitle>
          <DialogDescription>{t("csv.importOptionsDesc")}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto">
          {headers.map((header, col) => (
            <div key={col} className="border-b border-neutral-200 py-2 last:border-b-0 dark:border-neutral-800">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[13px]" title={header}>
                  {header}
                </span>
                <select
                  className="h-7 rounded-md border border-neutral-300 bg-white px-2 text-[12px] outline-none focus:border-brand-500 dark:border-neutral-700 dark:bg-neutral-900"
                  value={types[col]}
                  onChange={(e) => setType(col, e.target.value as FieldType)}
                >
                  {ALL_TYPE_ORDER.map((ft) => {
                    const reason = DISABLED_IMPORT_TYPES[ft];
                    return (
                      <option
                        key={ft}
                        value={ft}
                        disabled={reason !== undefined}
                        title={reason ? t(reason) : undefined}
                      >
                        {t(`field.type.${ft}` as MessageKey)}
                        {reason ? ` — ${t(reason)}` : ""}
                      </option>
                    );
                  })}
                </select>
              </div>
              {types[col] === "attachment" && (
                <div className="mt-2 flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={() => pickFolder(col)}>
                    {t("csv.attachment.chooseFolder")}
                  </Button>
                  <span className="min-w-0 flex-1 truncate text-[12px] text-neutral-500">
                    {folders[col]?.name ?? t("csv.attachment.noFolder")}
                  </span>
                  <span className="shrink-0 text-[12px] text-neutral-500">
                    {t("csv.attachment.stats", {
                      matched: stats[col]?.matched ?? 0,
                      missing: stats[col]?.missing ?? 0,
                    })}
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button onClick={confirm}>{t("csv.import")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
