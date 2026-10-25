// Grid 视图的「数据进出」一簇：CSV / xlsx 导出、TSV 剪贴板粘贴、CSV 导入（建新表与追加到当前表）。
// 这一簇只读渲染期的行/列/单元格与当前页 store，不产 JSX，也不持有自己的状态——
// importPlan 的存在与否仍由 GridView 的 useState 管，切片只在每次渲染收到当次快照。
import { save, open } from "@/lib/ipc-dialog";
import { invoke } from "@/lib/invoke";
import { toast } from "sonner";
import type { AttachmentRef, CellValue, DatabaseField, FieldType } from "@/types/database";
import { isReadonlyType } from "@/types/database";
import type { DatabaseState, DatabaseStore } from "@/stores/database";
import { useWorkspaceStore } from "@/stores/workspace";
import { viewApi, newId } from "@/lib/db";
import { isOptionBearing } from "@/lib/database-values";
import {
  buildCsvExport,
  buildSelectOptions,
  collectSelectNames,
  importCell,
  parseCsv,
  pasteCell,
  planImport,
  parseTsv,
  resolveAttachmentNames,
  type PasteDeps,
} from "@/lib/csv";
import { buildXlsxSheet, exportFileName, resolveExportCells } from "@/lib/table-export";
import { mapWithConcurrency } from "./grid-view-helpers";
import type { CellGraph, GridModel } from "./grid-view-model";
import type { UseGridViewModelResult } from "./use-grid-view-model";
import type { RefObject } from "react";
import type { View } from "@/types/models";
import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";

/** CSV 导入暂存计划：解析完成后先等用户在 CsvImportDialog 里确认各列类型，确认后才落库 */
export interface GridImportPlan {
  fileName: string;
  headers: string[];
  types: FieldType[];
  /** 数据行（不含表头） */
  dataRows: string[][];
}

/** 切片要的输入：全部来自宿主某一次渲染，返回的函数按那一次的值闭包（与搬之前在组件体内一致） */
export interface GridIoContext {
  /** 宿主页面：导出文件名取它的标题 */
  source: View;
  fields: DatabaseState["fields"];
  cells: CellGraph;
  displayRows: GridModel["displayRows"];
  displayCells: UseGridViewModelResult["displayCells"];
  relationDbOf: UseGridViewModelResult["relationDbOf"];
  visibleFields: GridModel["visibleFields"];
  /** 正在编辑的单元格：编辑中不接管剪贴板 */
  editing: { rowId: string; fieldId: string } | null;
  /** 最近一次点击的可编辑单元格：TSV 粘贴从这里向右向下展开 */
  pasteAnchorRef: RefObject<{ rowId: string; fieldId: string } | null>;
  store: DatabaseState;
  storeApi: DatabaseStore;
  importPlan: GridImportPlan | null;
  setImportPlan: (plan: GridImportPlan | null) => void;
}

/** 造出当前渲染快照下的导入/导出动作（同参数名注入，函数体与搬前逐字节相同） */
export function createGridIoSlice({
  source,
  fields,
  cells,
  displayRows,
  displayCells,
  relationDbOf,
  visibleFields,
  editing,
  pasteAnchorRef,
  store,
  storeApi,
  importPlan,
  setImportPlan,
}: GridIoContext) {
  // CSV / xlsx 导出：计算列先折成可导出值（见 resolveExportCells），只导出当前筛选/排序后的可见行
  const exportCells = () => resolveExportCells(fields, displayRows, cells, displayCells, relationDbOf);

  const exportCsv = async () => {
    try {
      // 前置 BOM：Excel 打开 UTF-8 CSV 才不会把中文显示成乱码
      const content = "\uFEFF" + buildCsvExport(fields, displayRows, exportCells());
      const target = await save({
        defaultPath: exportFileName(source.name, "csv"),
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (!target) return;
      await invoke("write_text_file", { path: target, content });
      toast.success(t("csv.exported"));
    } catch (e) {
      logger.error("csv export failed", e);
      toast.error(t("error.csv", { message: String(e) }));
    }
  };

  // xlsx 由 Rust 侧手写 OOXML 产出（见 commands/files/xlsx.rs）：前端只给列种类与值
  const exportXlsx = async () => {
    try {
      const name = source.name || "export";
      const target = await save({
        defaultPath: exportFileName(name, "xlsx"),
        filters: [{ name: "Excel", extensions: ["xlsx"] }],
      });
      if (!target) return;
      await invoke("export_xlsx", { path: target, sheet: buildXlsxSheet(name, fields, displayRows, exportCells()) });
      toast.success(t("xlsx.exported"));
    } catch (e) {
      logger.error("xlsx export failed", e);
      toast.error(t("error.xlsx", { message: String(e) }));
    }
  };

  // Excel/表格 TSV 剪贴板粘贴：从锚点单元格向右向下展开，行不够自动补行
  const onPasteTsv = async (e: React.ClipboardEvent) => {
    if (editing) return; // 编辑框里的粘贴走默认（单格文本）
    if (e.target instanceof HTMLElement && e.target.closest("input, textarea")) return;
    const text = e.clipboardData.getData("text/plain");
    if (!text || (!text.includes("\t") && !text.includes("\n"))) return;
    const grid = parseTsv(text);
    if (grid.length === 0 || grid[0].length === 0) return;
    const anchor = pasteAnchorRef.current;
    if (!anchor) {
      toast.info(t("csv.pasteNoAnchor"));
      return;
    }
    e.preventDefault();
    const startRow = displayRows.findIndex((r) => r.id === anchor.rowId);
    const startCol = visibleFields.findIndex((f) => f.id === anchor.fieldId);
    if (startRow < 0 || startCol < 0) return;
    try {
      let skipped = 0;
      // 预取行队列：现有行 + 粘贴时按需新建（一次 IPC 建全部缺行，不再逐行 await）
      const rowQueue: string[] = displayRows.slice(startRow).map((r) => r.id);
      const missingRows = grid.length - rowQueue.length;
      if (missingRows > 0) {
        const created = await store.addRows(missingRows);
        if (created.length !== missingRows) return;
        rowQueue.push(...created.map((r) => r.id));
      }
      // 单元格写入先攒后写：一次 cell_set_many 落整片粘贴（选项补建仍逐条，但那是低频路径）
      const pasteDeps: PasteDeps = {
        latestField: (fieldId) => storeApi.getState().fields.find((f) => f.id === fieldId),
        createOption: (fieldId, name) => store.addSelectOption(fieldId, name),
      };
      const updates: { rowId: string; fieldId: string; value: CellValue }[] = [];
      for (let i = 0; i < grid.length; i++) {
        for (let j = 0; j < grid[i].length; j++) {
          const field: DatabaseField | undefined = visibleFields[startCol + j];
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- noUncheckedIndexedAccess 关闭使索引返回非空类型，但粘贴网格列数可能超出可见列，运行时会越界返回 undefined
          if (!field) {
            skipped++; // 超出最右列
            continue;
          }
          // 类型怎么读这段文本、缺的选项怎么补，都在 pasteCell 里（与 CSV 追加同一条路径）
          const pasted = await pasteCell(field, grid[i][j], pasteDeps);
          if (!pasted) {
            skipped++; // 只读/关联/附件与未配选项的选择列：文本给不出合法值
            continue;
          }
          if (pasted.degraded) skipped++; // 选项补建失败，写出去的值不完整
          updates.push({ rowId: rowQueue[i], fieldId: field.id, value: pasted.value });
        }
      }
      // 选择类补建过选项时会刷新 fields，但 cells 只在这里写一次，顺序上不冲突
      await store.setCellsMany(updates);
      const filled = updates.length;
      if (filled > 0) toast.success(t("csv.pasted", { n: String(filled) }));
      if (skipped > 0) toast.warning(t("csv.pasteSkipped", { n: String(skipped) }));
    } catch (err) {
      logger.error("tsv paste failed", err);
      toast.error(t("error.csv", { message: String(err) }));
    }
  };

  // CSV 导入（新表）：先选文件并解析，再弹对话框让用户确认各列类型，确认后才落库
  const importCsv = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (typeof selected !== "string") return;
      const text = await invoke<string>("read_text_file", { path: selected });
      const parsed = parseCsv(text);
      if (parsed.length === 0) {
        toast.error(t("csv.emptyFile"));
        return;
      }
      const { headers, types } = planImport(parsed);
      // 新表名取文件名
      const base =
        selected
          .split(/[\\/]/)
          .pop()
          ?.replace(/\.csv$/i, "") ?? "";
      const fileName = base.length > 0 ? base : t("csv.importDefaultName");
      setImportPlan({ fileName, headers, types, dataRows: parsed.slice(1) });
    } catch (e) {
      logger.error("csv import failed", e);
      toast.error(t("error.csv", { message: String(e) }));
    }
  };

  /** 追加到当前表：列名匹配现有可写字段（忽略大小写/空白），逐行建空行再批量写单元格；
   *  未匹配或只读派生列跳过并提示。选择列缺的选项当场补建（与 TSV 粘贴同一套路径）。 */
  const runAppendCsv = async (foldersByColumn: Record<number, Record<string, string>>) => {
    const plan = importPlan;
    if (!plan) return;
    try {
      const byName = new Map<string, DatabaseField>();
      for (const f of fields) {
        const key = f.name.trim().toLowerCase();
        if (!byName.has(key)) byName.set(key, f);
      }
      const colTargets = plan.headers.map((h) => {
        const f = byName.get(h.trim().toLowerCase()) ?? null;
        if (!f || isReadonlyType(f.field_type) || f.field_type === "relation") return null;
        return f;
      });
      const skippedCols = colTargets.filter((f) => f === null).length;
      if (colTargets.length > 0 && skippedCols === colTargets.length) {
        toast.error(t("csv.appendNoMatch"));
        return;
      }
      // 附件列与新建表路径同构：文件夹文件名索引 → save_asset 复制 → 写 AttachmentRef 数组
      const pendingSources = new Set<string>();
      const resolved: Record<number, { matched: { name: string; sourcePath: string }[]; missing: string[] }[]> = {};
      colTargets.forEach((f, col) => {
        if (f?.field_type !== "attachment") return;
        const files = foldersByColumn[col] ?? {};
        resolved[col] = plan.dataRows.map((line) => {
          const r = resolveAttachmentNames(line[col] ?? "", files);
          for (const m of r.matched) pendingSources.add(m.sourcePath);
          return r;
        });
      });
      const relBySource = new Map<string, string>();
      await mapWithConcurrency([...pendingSources], 8, async (sourcePath) => {
        try {
          relBySource.set(sourcePath, await invoke<string>("save_asset", { sourcePath }));
        } catch (e) {
          logger.warn("csv-import.save_asset", "save_asset failed", sourcePath, e);
        }
      });

      const created = await store.addRows(plan.dataRows.length);
      const pasteDeps: PasteDeps = {
        latestField: (fieldId) => storeApi.getState().fields.find((f) => f.id === fieldId),
        createOption: (fieldId, name) => store.addSelectOption(fieldId, name),
      };
      const updates: { rowId: string; fieldId: string; value: CellValue }[] = [];
      const missingNames = new Set<string>();
      for (let ri = 0; ri < plan.dataRows.length; ri++) {
        const rowId = created[ri]?.id;
        if (!rowId) continue;
        const line = plan.dataRows[ri];
        for (let col = 0; col < colTargets.length; col++) {
          const field = colTargets[col];
          if (!field) continue;
          const raw = line[col] ?? "";
          if (raw.trim() === "") continue;
          if (field.field_type === "attachment") {
            const refs: AttachmentRef[] = [];
            for (const m of resolved[col][ri].matched) {
              const path = relBySource.get(m.sourcePath);
              if (path) refs.push({ name: m.name, path });
              else missingNames.add(m.name);
            }
            for (const name of resolved[col][ri].missing) missingNames.add(name);
            if (refs.length > 0) updates.push({ rowId, fieldId: field.id, value: refs });
            continue;
          }
          const pasted = await pasteCell(field, raw, pasteDeps);
          if (pasted) updates.push({ rowId, fieldId: field.id, value: pasted.value });
        }
      }
      await store.setCellsMany(updates);
      toast.success(t("csv.appended", { count: String(created.length) }));
      if (skippedCols > 0) toast.warning(t("csv.appendSkippedCols", { n: String(skippedCols) }));
      if (missingNames.size > 0) {
        const names = [...missingNames];
        const shown = names.slice(0, 5).join(", ") + (names.length > 5 ? ` …(+${names.length - 5})` : "");
        toast.warning(t("csv.attachment.missingToast", { n: String(names.length), names: shown }));
      }
    } catch (e) {
      logger.error("csv append failed", e);
      toast.error(t("error.csv", { message: String(e) }));
    }
  };

  /** 用户确认字段类型后执行真正的导入：建视图 → 建字段/行 → csv_import。
   *  附件列把「候选文件名」在所选文件夹索引里匹配，命中的先复制进 assets/ 再写单元格。 */
  const runImportCsv = async (
    types: FieldType[],
    foldersByColumn: Record<number, Record<string, string>>,
    target: "new" | "current",
  ) => {
    const plan = importPlan;
    setImportPlan(null);
    if (!plan) return;
    if (target === "current") {
      await runAppendCsv(foldersByColumn);
      return;
    }
    try {
      const wsId = useWorkspaceStore.getState().currentWorkspaceId;
      if (!wsId) return;
      // 新表 = 新 grid 视图
      const newView = await viewApi.create({
        workspace_id: wsId,
        parent_id: null,
        name: plan.fileName,
        layout: "grid",
      });
      // 建字段（重名则加序号）—— 解析/类型推断/消歧/id 生成在 JS，落库由 csv_import 单命令完成
      // 选择列：按列值收集去重选项名 → 生成 options（名 → id），单元格按名转 id 存
      const used = new Set<string>();
      const selectIdMaps: Record<number, Map<string, string>> = {};
      const fields = plan.headers.map((header, i) => {
        let name = header;
        while (used.has(name)) name = name + " 2";
        used.add(name);
        if (isOptionBearing(types[i])) {
          const names = collectSelectNames(
            types[i],
            plan.dataRows.map((r) => r[i] ?? ""),
          );
          const { options, idByName } = buildSelectOptions(names);
          selectIdMaps[i] = idByName;
          return { id: newId(), name, field_type: types[i], options: JSON.stringify({ kind: "select", options }) };
        }
        return { id: newId(), name, field_type: types[i], options: null };
      });

      // 附件列：逐行解析候选名（纯函数），收集待复制文件（按源路径去重）
      const attachmentCols: number[] = [];
      fields.forEach((f, i) => {
        if (f.field_type === "attachment") attachmentCols.push(i);
      });
      const resolved: Record<number, { matched: { name: string; sourcePath: string }[]; missing: string[] }[]> = {};
      const pendingSources = new Set<string>();
      for (const col of attachmentCols) {
        const files = foldersByColumn[col] ?? {};
        resolved[col] = plan.dataRows.map((line) => {
          const r = resolveAttachmentNames(line[col] ?? "", files);
          for (const m of r.matched) pendingSources.add(m.sourcePath);
          return r;
        });
      }
      // 先按去重后的源路径各复制一次（有上限并发），缓存「源路径 → assets 相对路径」避免重复复制
      const relBySource = new Map<string, string>();
      await mapWithConcurrency([...pendingSources], 8, async (sourcePath) => {
        try {
          relBySource.set(sourcePath, await invoke<string>("save_asset", { sourcePath }));
        } catch (e) {
          // 单个文件复制失败只记日志，后续按未匹配处理，不中断整次导入
          logger.warn("csv-import.save_asset", "save_asset failed", sourcePath, e);
        }
      });

      const missingNames = new Set<string>();
      // 嵌套 payload 按 Rust 结构体声明的 snake_case 键传（同 mention_rebuild 契约）
      const rows = plan.dataRows.map((line, ri) => {
        const cells: { field_id: string; value: string }[] = [];
        for (let i = 0; i < fields.length; i++) {
          const raw = line[i] ?? "";
          if (raw.trim() === "") continue;
          if (fields[i].field_type === "attachment") {
            const refs: AttachmentRef[] = [];
            for (const m of resolved[i][ri].matched) {
              const path = relBySource.get(m.sourcePath);
              if (path) refs.push({ name: m.name, path });
              else missingNames.add(m.name);
            }
            for (const name of resolved[i][ri].missing) missingNames.add(name);
            if (refs.length === 0) continue;
            cells.push({ field_id: fields[i].id, value: JSON.stringify(refs) });
            continue;
          }
          const cell = importCell(fields[i].field_type, raw, selectIdMaps[i]);
          if (cell !== null) cells.push({ field_id: fields[i].id, value: JSON.stringify(cell) });
        }
        return { id: newId(), cells };
      });
      await invoke("csv_import", { viewId: newView.id, fields, rows });
      await useWorkspaceStore.getState().reload();
      useWorkspaceStore.getState().openView(newView.id);
      toast.success(t("csv.imported", { count: String(plan.dataRows.length) }));
      if (missingNames.size > 0) {
        const names = [...missingNames];
        const shown = names.slice(0, 5).join(", ") + (names.length > 5 ? ` …(+${names.length - 5})` : "");
        toast.warning(t("csv.attachment.missingToast", { n: String(names.length), names: shown }));
      }
    } catch (e) {
      logger.error("csv import failed", e);
      toast.error(t("error.csv", { message: String(e) }));
    }
  };

  return { exportCsv, exportXlsx, onPasteTsv, importCsv, runImportCsv };
}
