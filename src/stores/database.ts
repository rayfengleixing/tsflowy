import { create } from "zustand";
import type { CellValue, DatabaseField, DatabaseRow, FieldOptions, FieldType } from "@/types/database";
import { databaseApi } from "@/lib/database";
import { newSelectOption, parseFieldOptions } from "@/lib/database-values";
import { renameFormulaRef } from "@/lib/database-formula";
import { viewApi } from "@/lib/db";
import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import { toast } from "sonner";
import type { FilterMode, FilterSpec, SortSpec } from "@/lib/database-query";
import { patchViewConfig, readViewConfig } from "@/lib/view-config";
import type { View } from "@/types/models";

// 数据库视图的字段/行/单元格缓存（项目说明书 3 章 stores/database.ts）。
// 单窗口单视图：一次只服务当前打开的数据库视图，切换视图时整体重载。

interface DatabaseState {
  viewId: string | null;
  /** 当前视图行（写回 extra 配置用；viewId 保持原有语义不变） */
  view: View | null;
  fields: DatabaseField[];
  rows: DatabaseRow[];
  cells: Record<string, Record<string, CellValue>>;
  loading: boolean;

  // 排序/筛选（持久化到 views.extra）
  sorts: SortSpec[];
  filters: FilterSpec[];
  filterMode: FilterMode;
  setSorts: (sorts: SortSpec[]) => void;
  setFilters: (filters: FilterSpec[], mode: FilterMode) => void;

  load: (view: View) => Promise<void>;
  reload: () => Promise<void>;

  // 字段
  addField: (type: FieldType, name?: string) => Promise<DatabaseField | null>;
  renameField: (id: string, name: string) => Promise<void>;
  changeFieldType: (id: string, type: FieldType) => Promise<void>;
  removeField: (id: string) => Promise<void>;
  setFieldWidth: (id: string, width: number) => Promise<void>;
  toggleFieldHidden: (id: string) => Promise<void>;
  reorderFields: (orderedIds: string[]) => Promise<void>;
  updateFieldOptions: (id: string, options: FieldOptions) => Promise<void>;
  addSelectOption: (id: string, name: string) => Promise<string | null>;
  removeSelectOption: (id: string, optionId: string) => Promise<void>;

  // 行
  addRow: () => Promise<DatabaseRow | null>;
  /** 批量建行（TSV 粘贴）：一次 IPC 一个事务 */
  addRows: (count: number) => Promise<DatabaseRow[]>;
  removeRow: (id: string) => Promise<void>;
  /** 批量删行（多选删除）：一次 IPC 一个事务 */
  removeRows: (ids: string[]) => Promise<number>;
  /** 复制所选行：新建行并复制其单元格值（含公式引用之外的存储值），返回新行 */
  duplicateRows: (ids: string[]) => Promise<DatabaseRow[]>;
  reorderRows: (orderedIds: string[]) => Promise<void>;

  // 单元格
  setCell: (rowId: string, fieldId: string, value: CellValue) => Promise<void>;
  /** 批量写单元格（TSV 粘贴）：一次 IPC 一个事务 */
  setCellsMany: (updates: { rowId: string; fieldId: string; value: CellValue }[]) => Promise<void>;

  // 行详情（右侧滑出面板）
  rowDetail: { row: DatabaseRow; view: View } | null;
  /** host：宿主页面视图（派生视图不带子节点，行详情文档一律挂在宿主下） */
  openRowDetail: (row: DatabaseRow, host: View) => Promise<void>;
  closeRowDetail: () => void;

  /** 搜索命中的行：表格/看板/日历据此滚动定位并短时高亮（瞬时状态，不落库） */
  focusRowId: string | null;
  setFocusRow: (rowId: string) => void;
  clearFocusRow: () => void;
}

// 并发 load/reload 只允许最新一次写入：快速切换视图时慢请求的旧数据不能盖住新视图
// （DatabasePage 按 view.id 渲染 store 数据，不校验响应来自哪次请求）
let loadSeq = 0;

/** 清除所有单元格对已删除选项的引用（单选置 null / 多选剔除该项）并逐行落库。
 *  字段设置弹窗与单元格下拉两条删除选项的路径共用，否则弹窗路径会留下悬空 id。 */
async function clearRemovedOptionRefs(
  set: (partial: Partial<DatabaseState>) => void,
  get: () => DatabaseState,
  fieldId: string,
  removed: string[],
) {
  const gone = new Set(removed);
  const cells = { ...get().cells };
  const changed: { rowId: string; value: CellValue }[] = [];
  for (const [rowId, rowCells] of Object.entries(cells)) {
    const v = rowCells[fieldId];
    if (typeof v === "string" && gone.has(v)) {
      rowCells[fieldId] = null;
      changed.push({ rowId, value: null });
    } else if (Array.isArray(v) && v.some((x) => gone.has(x))) {
      const next = v.filter((x) => !gone.has(x));
      rowCells[fieldId] = next;
      changed.push({ rowId, value: next });
    }
  }
  if (changed.length === 0) return;
  set({ cells });
  for (const c of changed) await databaseApi.setCell(c.rowId, fieldId, c.value);
}

export const useDatabaseStore = create<DatabaseState>()((set, get) => ({
  viewId: null,
  view: null,
  fields: [],
  rows: [],
  cells: {},
  loading: false,
  sorts: [],
  filters: [],
  filterMode: "and",
  rowDetail: null,
  focusRowId: null,

  setSorts: (sorts) => {
    set({ sorts });
    const view = get().view;
    if (view) patchViewConfig(view, { sorts });
  },
  setFilters: (filters, filterMode) => {
    set({ filters, filterMode });
    const view = get().view;
    if (view) patchViewConfig(view, { filters, filterMode });
  },

  load: async (view) => {
    const viewId = view.id;
    if (get().viewId === viewId && get().fields.length > 0) return;
    const seq = ++loadSeq;
    const cfg = readViewConfig(view);
    set({
      loading: true,
      view,
      viewId,
      sorts: cfg.sorts ?? [],
      filters: cfg.filters ?? [],
      filterMode: cfg.filterMode ?? "and",
    });
    try {
      const [fields, rows, cells] = await Promise.all([
        databaseApi.listFields(viewId),
        databaseApi.listRows(viewId),
        databaseApi.loadCells(viewId),
      ]);
      // 等待期间已切到别的视图（viewId 变了）或有更新的请求 → 丢弃本次结果，不碰 loading
      if (seq !== loadSeq || get().viewId !== viewId) return;
      set({ fields, rows, cells, loading: false });
    } catch (e) {
      if (seq === loadSeq) {
        logger.error("database.load", e);
        toast.error(t("error.db", { message: String(e) }));
        set({ loading: false });
      }
      throw e;
    }
  },

  reload: async () => {
    const viewId = get().viewId;
    if (!viewId) return;
    const seq = ++loadSeq;
    const [fields, rows, cells] = await Promise.all([
      databaseApi.listFields(viewId),
      databaseApi.listRows(viewId),
      databaseApi.loadCells(viewId),
    ]);
    if (seq !== loadSeq || get().viewId !== viewId) return;
    set({ fields, rows, cells });
  },

  addField: async (type, name) => {
    const viewId = get().viewId;
    if (!viewId) return null;
    const field = await databaseApi.createField(viewId, type, name);
    set({ fields: [...get().fields, field] });
    return field;
  },

  renameField: async (id, name) => {
    const before = get().fields.find((f) => f.id === id);
    await databaseApi.renameField(id, name);
    set({ fields: get().fields.map((f) => (f.id === id ? { ...f, name } : f)) });
    if (!before || before.name === name) return;
    // 公式以 {字段名} 引用：不同步改写的话，重命名会让引用该字段的公式全部变空
    const formulas = get().fields.filter((f) => f.id !== id && parseFieldOptions(f.options).kind === "formula");
    for (const f of formulas) {
      const opts = parseFieldOptions(f.options);
      if (opts.kind !== "formula") continue;
      const next = renameFormulaRef(opts.formula, before.name, name);
      if (next === opts.formula) continue;
      await get().updateFieldOptions(f.id, { ...opts, formula: next });
    }
  },

  changeFieldType: async (id, type) => {
    const field = get().fields.find((f) => f.id === id);
    if (field?.field_type === type) return; // 同类型重选：不清列、不重置选项
    await databaseApi.changeFieldType(id, type);
    await get().reload();
  },

  removeField: async (id) => {
    await databaseApi.deleteField(id);
    set({ fields: get().fields.filter((f) => f.id !== id) });
    // 清理本地单元格缓存与排序/筛选引用
    const cells = { ...get().cells };
    for (const rowId of Object.keys(cells)) {
      delete cells[rowId][id];
    }
    set({
      cells,
      sorts: get().sorts.filter((s) => s.field_id !== id),
      filters: get().filters.filter((f) => f.field_id !== id),
    });
  },

  setFieldWidth: async (id, width) => {
    await databaseApi.setFieldWidth(id, width);
    set({ fields: get().fields.map((f) => (f.id === id ? { ...f, width } : f)) });
  },

  toggleFieldHidden: async (id) => {
    const field = get().fields.find((f) => f.id === id);
    if (!field) return;
    await databaseApi.setFieldHidden(id, field.is_hidden === 0);
    set({ fields: get().fields.map((f) => (f.id === id ? { ...f, is_hidden: f.is_hidden === 0 ? 1 : 0 } : f)) });
  },

  reorderFields: async (orderedIds) => {
    const viewId = get().viewId;
    if (!viewId) return;
    await databaseApi.reorderFields(viewId, orderedIds);
    set({ fields: [...orderedIds].map((id, i) => ({ ...get().fields.find((f) => f.id === id)!, position: i })) });
  },

  updateFieldOptions: async (id, options) => {
    const before = get().fields.find((f) => f.id === id);
    await databaseApi.updateFieldOptions(id, options);
    set({ fields: get().fields.map((f) => (f.id === id ? { ...f, options: JSON.stringify(options) } : f)) });
    if (!before) return;
    const prev = parseFieldOptions(before.options);
    if (prev.kind !== "select" || options.kind !== "select") return;
    const kept = new Set(options.options.map((o) => o.id));
    const removed = prev.options.filter((o) => !kept.has(o.id)).map((o) => o.id);
    if (removed.length > 0) await clearRemovedOptionRefs(set, get, id, removed);
  },

  addSelectOption: async (id, name) => {
    const field = get().fields.find((f) => f.id === id);
    if (!field) return null;
    const opts = parseFieldOptions(field.options);
    if (opts.kind !== "select") return null;
    const option = newSelectOption(name);
    const next: FieldOptions = { ...opts, options: [...opts.options, option] };
    await databaseApi.updateFieldOptions(id, next);
    set({ fields: get().fields.map((f) => (f.id === id ? { ...f, options: JSON.stringify(next) } : f)) });
    return option.id;
  },

  /** 删除选项：从字段 options 移除（单元格清理统一由 updateFieldOptions 完成） */
  removeSelectOption: async (id, optionId) => {
    const field = get().fields.find((f) => f.id === id);
    if (!field) return;
    const opts = parseFieldOptions(field.options);
    if (opts.kind !== "select") return;
    await get().updateFieldOptions(id, { ...opts, options: opts.options.filter((o) => o.id !== optionId) });
  },

  addRow: async () => {
    const viewId = get().viewId;
    if (!viewId) return null;
    const row = await databaseApi.createRow(viewId);
    set({ rows: [...get().rows, row] });
    return row;
  },

  addRows: async (count) => {
    const viewId = get().viewId;
    if (!viewId || count <= 0) return [];
    const created = await databaseApi.createRows(viewId, count);
    set({ rows: [...get().rows, ...created] });
    return created;
  },

  removeRow: async (id) => {
    await databaseApi.deleteRow(id);
    set({ rows: get().rows.filter((r) => r.id !== id) });
  },

  removeRows: async (ids) => {
    if (ids.length === 0) return 0;
    const gone = new Set(ids);
    const n = await databaseApi.deleteRows(ids);
    const cells = { ...get().cells };
    for (const id of ids) delete cells[id];
    set({ rows: get().rows.filter((r) => !gone.has(r.id)), cells });
    return n;
  },

  duplicateRows: async (ids) => {
    const viewId = get().viewId;
    if (!viewId || ids.length === 0) return [];
    // 新行顺序按当前表格行序（store 顺序 = position 顺序，与选择顺序无关）
    const src = new Set(ids);
    const ordered = get().rows.filter((r) => src.has(r.id));
    if (ordered.length === 0) return [];
    const created = await databaseApi.createRows(viewId, ordered.length);
    // 逐行搬运存储值：新行 id 与源行 id 一一对应
    const updates: { rowId: string; fieldId: string; value: CellValue }[] = [];
    for (let i = 0; i < ordered.length; i++) {
      const rowCells = get().cells[ordered[i].id] ?? {};
      for (const [fieldId, value] of Object.entries(rowCells)) {
        updates.push({ rowId: created[i].id, fieldId, value });
      }
    }
    if (updates.length > 0) {
      await databaseApi.setCellsMany(updates);
      const cells = { ...get().cells };
      for (const u of updates) {
        cells[u.rowId] = { ...(cells[u.rowId] ?? {}), [u.fieldId]: u.value };
      }
      set({ rows: [...get().rows, ...created], cells });
    } else {
      set({ rows: [...get().rows, ...created] });
    }
    return created;
  },

  reorderRows: async (orderedIds) => {
    const viewId = get().viewId;
    if (!viewId) return;
    await databaseApi.reorderRows(viewId, orderedIds);
    set({ rows: [...orderedIds].map((id, i) => ({ ...get().rows.find((r) => r.id === id)!, position: i })) });
  },

  setCell: async (rowId, fieldId, value) => {
    await databaseApi.setCell(rowId, fieldId, value);
    const cells = { ...get().cells };
    (cells[rowId] ??= {})[fieldId] = value;
    set({ cells });
  },

  setCellsMany: async (updates) => {
    if (updates.length === 0) return;
    await databaseApi.setCellsMany(updates);
    const cells = { ...get().cells };
    for (const u of updates) {
      // 逐行浅拷贝后替换：不原地改上一份 state 里的对象
      const rowCells = { ...(cells[u.rowId] ?? {}) };
      rowCells[u.fieldId] = u.value;
      cells[u.rowId] = rowCells;
    }
    set({ cells });
  },

  openRowDetail: async (row, host) => {
    try {
      // 用最新行数据（document_id 可能已被之前会话更新，store 里是旧副本）
      const fresh = await databaseApi.getRow(row.id);
      if (!fresh) throw new Error("row missing: " + row.id);
      row = fresh;
      if (!row.document_id) {
        // 首次打开：创建行详情文档 view（extra 标记 row_detail，说明书 12 节风险 7）
        const name = t("row.detailName", { n: row.position + 1 });
        const view = await viewApi.create({
          workspace_id: host.workspace_id,
          parent_id: host.id,
          name,
          layout: "document",
          extra: JSON.stringify({ row_detail: true }),
        });
        await databaseApi.setRowDocumentId(row.id, view.id);
        // 同步 store 里的行（document_id 绑定）
        const bound = { ...row, document_id: view.id };
        set({ rows: get().rows.map((r) => (r.id === bound.id ? bound : r)), rowDetail: { row: bound, view } });
      } else {
        // 已有文档：从库中读回 view（含名称等）
        const view = await viewApi.get(row.document_id);
        if (!view) throw new Error("row detail view missing: " + row.document_id);
        set({ rowDetail: { row, view } });
      }
    } catch (e) {
      logger.error("open row detail failed", e);
      toast.error(t("error.db", { message: String(e) }));
    }
  },

  closeRowDetail: () => set({ rowDetail: null }),

  setFocusRow: (rowId) => set({ focusRowId: rowId }),
  clearFocusRow: () => set({ focusRowId: null }),
}));
