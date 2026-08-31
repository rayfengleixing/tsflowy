import { create } from "zustand";
import type { CellValue, DatabaseField, DatabaseRow, FieldOptions, FieldType } from "@/types/database";
import { databaseApi } from "@/lib/database";
import { viewApi } from "@/lib/db";
import type { FilterMode, FilterSpec, SortSpec } from "@/lib/database-query";
import type { View } from "@/types/models";

// 数据库视图的字段/行/单元格缓存（项目说明书 3 章 stores/database.ts）。
// 单窗口单视图：一次只服务当前打开的数据库视图，切换视图时整体重载。

interface DatabaseState {
  viewId: string | null;
  fields: DatabaseField[];
  rows: DatabaseRow[];
  cells: Record<string, Record<string, CellValue>>;
  loading: boolean;

  // 排序/筛选（本地 UI 状态）
  sorts: SortSpec[];
  filters: FilterSpec[];
  filterMode: FilterMode;
  setSorts: (sorts: SortSpec[]) => void;
  setFilters: (filters: FilterSpec[], mode: FilterMode) => void;

  load: (viewId: string) => Promise<void>;
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

  // 行
  addRow: () => Promise<DatabaseRow | null>;
  removeRow: (id: string) => Promise<void>;
  reorderRows: (orderedIds: string[]) => Promise<void>;

  // 单元格
  setCell: (rowId: string, fieldId: string, value: CellValue) => Promise<void>;

  // 行详情（右侧滑出面板）
  rowDetail: { row: DatabaseRow; view: View } | null;
  openRowDetail: (row: DatabaseRow, dbView: View) => Promise<void>;
  closeRowDetail: () => void;
}

export const useDatabaseStore = create<DatabaseState>()((set, get) => ({
  viewId: null,
  fields: [],
  rows: [],
  cells: {},
  loading: false,
  sorts: [],
  filters: [],
  filterMode: "and",
  rowDetail: null,

  setSorts: (sorts) => set({ sorts }),
  setFilters: (filters, filterMode) => set({ filters, filterMode }),

  load: async (viewId) => {
    if (get().viewId === viewId && get().fields.length > 0) return;
    set({ loading: true, viewId, sorts: [], filters: [] });
    try {
      const [fields, rows, cells] = await Promise.all([
        databaseApi.listFields(viewId),
        databaseApi.listRows(viewId),
        databaseApi.loadCells(viewId),
      ]);
      set({ fields, rows, cells, loading: false });
    } catch (e) {
      console.error("load database view failed", viewId, e);
      set({ loading: false });
      throw e;
    }
  },

  reload: async () => {
    const viewId = get().viewId;
    if (!viewId) return;
    const [fields, rows, cells] = await Promise.all([
      databaseApi.listFields(viewId),
      databaseApi.listRows(viewId),
      databaseApi.loadCells(viewId),
    ]);
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
    await databaseApi.renameField(id, name);
    set({ fields: get().fields.map((f) => (f.id === id ? { ...f, name } : f)) });
  },

  changeFieldType: async (id, type) => {
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
    await databaseApi.updateFieldOptions(id, options);
    set({ fields: get().fields.map((f) => (f.id === id ? { ...f, options: JSON.stringify(options) } : f)) });
  },

  addRow: async () => {
    const viewId = get().viewId;
    if (!viewId) return null;
    const row = await databaseApi.createRow(viewId);
    set({ rows: [...get().rows, row] });
    return row;
  },

  removeRow: async (id) => {
    await databaseApi.deleteRow(id);
    set({ rows: get().rows.filter((r) => r.id !== id) });
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

  openRowDetail: async (row, dbView) => {
    try {
      if (!row.document_id) {
        // 首次打开：创建行详情文档 view（extra 标记 row_detail，说明书 12 节风险 7）
        const name = "行 " + (row.position + 1);
        const view = await viewApi.create({
          workspace_id: dbView.workspace_id,
          parent_id: dbView.id,
          name,
          layout: "document",
          extra: JSON.stringify({ row_detail: true }),
        });
        await databaseApi.setRowDocumentId(row.id, view.id);
        set({ rowDetail: { row: { ...row, document_id: view.id }, view } });
      } else {
        // 已有文档：从库中读回 view（含名称等）
        const view = await viewApi.get(row.document_id);
        if (!view) throw new Error("row detail view missing: " + row.document_id);
        set({ rowDetail: { row, view } });
      }
    } catch (e) {
      console.error("open row detail failed", e);
    }
  },

  closeRowDetail: () => set({ rowDetail: null }),
}));