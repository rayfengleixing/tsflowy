import { invoke } from "@tauri-apps/api/core";
import type { CellValue, DatabaseField, DatabaseRow, FieldOptions, FieldType } from "@/types/database";
import { newId } from "./db";
import { deserializeValue } from "./database-values";

// 数据库三表 CRUD（项目说明书 7 章 DDL / 9.3 节）：Phase C 起走 Rust 领域命令，
// 写串行化由 Rust 侧 write 连接互斥保证，字段默认 options 也由 Rust 侧生成。
// 行详情文档（database_rows.document_id）由 features/database 层负责创建 view。

export const databaseApi = {
  // ---------- 字段 ----------
  async listFields(viewId: string): Promise<DatabaseField[]> {
    return invoke<DatabaseField[]>("field_list", { viewId });
  },

  async createField(viewId: string, type: FieldType, name?: string): Promise<DatabaseField> {
    return invoke<DatabaseField>("field_create", { viewId, id: newId(), fieldType: type, name: name ?? null });
  },

  async renameField(fieldId: string, name: string): Promise<void> {
    return invoke("field_rename", { fieldId, name });
  },

  async deleteField(fieldId: string): Promise<void> {
    return invoke("field_delete", { fieldId }); // cells 级联
  },

  async setFieldWidth(fieldId: string, width: number): Promise<void> {
    return invoke("field_set_width", { fieldId, width });
  },

  async setFieldHidden(fieldId: string, hidden: boolean): Promise<void> {
    return invoke("field_set_hidden", { fieldId, hidden });
  },

  async updateFieldOptions(fieldId: string, options: FieldOptions): Promise<void> {
    return invoke("field_update_options", { fieldId, options: JSON.stringify(options) });
  },

  /** 整列重排：orderedIds 为最终顺序（position 0..n-1） */
  async reorderFields(viewId: string, orderedIds: string[]): Promise<void> {
    return invoke("field_reorder", { viewId, orderedIds });
  },

  /** 改字段类型：清空该字段所有单元格值（类型不兼容的数据不可保留） */
  async changeFieldType(fieldId: string, newType: FieldType): Promise<void> {
    return invoke("field_change_type", { fieldId, newType });
  },

  // ---------- 行 ----------
  async listRows(viewId: string): Promise<DatabaseRow[]> {
    return invoke<DatabaseRow[]>("row_list", { viewId });
  },

  async createRow(viewId: string): Promise<DatabaseRow> {
    return invoke<DatabaseRow>("row_create", { viewId, id: newId() });
  },

  /** 按 id 读单个行（行详情重开时需要最新 document_id） */
  async getRow(rowId: string): Promise<DatabaseRow | null> {
    return invoke<DatabaseRow | null>("row_get", { rowId });
  },

  /** 绑定行详情文档 view（首次打开行详情时创建） */
  async setRowDocumentId(rowId: string, documentId: string): Promise<void> {
    return invoke("row_set_document_id", { rowId, documentId });
  },

  async deleteRow(rowId: string): Promise<void> {
    return invoke("row_delete", { rowId }); // cells 级联
  },

  async reorderRows(viewId: string, orderedIds: string[]): Promise<void> {
    return invoke("row_reorder", { viewId, orderedIds });
  },

  // ---------- 单元格 ----------
  /** 全量读取：rowId → fieldId → 值 */
  async loadCells(viewId: string): Promise<Record<string, Record<string, CellValue>>> {
    const rows = await invoke<{ row_id: string; field_id: string; value: string }[]>("cells_load", { viewId });
    const out: Record<string, Record<string, CellValue>> = {};
    for (const row of rows) {
      (out[row.row_id] ??= {})[row.field_id] = deserializeValue("text", row.value);
    }
    return out;
  },

  async setCell(rowId: string, fieldId: string, value: CellValue): Promise<void> {
    return invoke("cell_set", { rowId, fieldId, value: JSON.stringify(value) });
  },
};
