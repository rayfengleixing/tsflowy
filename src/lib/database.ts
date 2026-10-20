import { invoke } from "@/lib/invoke";
import type {
  CellValue,
  DatabaseField,
  DatabaseRow,
  DatabaseTrashRow,
  FieldOptions,
  FieldType,
} from "@/types/database";
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

  /** 关联列选定/改指目标表：Rust 侧一个事务里在对端建（或复用）反向关系列并写回本列 options。
   *  reverseFieldId 等于传入的 reverseId 时说明这条反向列是新建的（前端据此提示）。 */
  async pairRelationTarget(
    fieldId: string,
    targetViewId: string,
    reverseId: string,
    reverseName: string,
  ): Promise<{ relation_field: DatabaseField; reverse_field_id: string }> {
    return invoke("field_pair_relation", { fieldId, targetViewId, reverseId, reverseName });
  },

  /** 整列重排：orderedIds 为最终顺序（position 0..n-1） */
  async reorderFields(viewId: string, orderedIds: string[]): Promise<void> {
    return invoke("field_reorder", { viewId, orderedIds });
  },

  /**
   * 改字段类型：清空该字段所有单元格值（类型不兼容的数据不可保留）。
   * 返回后端留存的旧值条数（>0 时本轮改动可在提示条里撤销）。
   */
  async changeFieldType(fieldId: string, newType: FieldType): Promise<number> {
    return invoke<number>("field_change_type", { fieldId, newType });
  },

  /** 把留存的一列取值连同字段定义一起还原回改类型前，返回还原条数 */
  async restoreFieldValues(fieldId: string): Promise<number> {
    return invoke<number>("field_restore_values", { fieldId });
  },

  // ---------- 行 ----------
  async listRows(viewId: string): Promise<DatabaseRow[]> {
    return invoke<DatabaseRow[]>("row_list", { viewId });
  },

  async createRow(viewId: string, parentId?: string | null): Promise<DatabaseRow> {
    return invoke<DatabaseRow>("row_create", { viewId, id: newId(), parentId: parentId ?? null });
  },

  /** 改父行（parentId 传 null 升到顶层）；成环/超深由 Rust 侧拒绝并返回错误文案 */
  async setRowParent(rowId: string, parentId: string | null): Promise<void> {
    return invoke("row_set_parent", { rowId, parentId });
  },

  /** 批量建行（TSV 粘贴补行）：一次 IPC 一个事务，返回按 position 顺序的新行 */
  async createRows(viewId: string, count: number): Promise<DatabaseRow[]> {
    const ids = Array.from({ length: count }, () => newId());
    return invoke<DatabaseRow[]>("row_create_many", { viewId, ids });
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
    return invoke("row_delete", { rowId }); // 进回收站，可用 row_restore 找回
  },

  /** 批量删行（多选删除）：一次 IPC 一个事务，返回实际进回收站的行数 */
  async deleteRows(rowIds: string[]): Promise<number> {
    return invoke<number>("row_delete_many", { rowIds });
  },

  /** 本表的回收站内容（按删除时间倒序） */
  async listTrash(viewId: string): Promise<DatabaseTrashRow[]> {
    return invoke<DatabaseTrashRow[]>("row_list_trash", { viewId });
  },

  /** 从回收站恢复一行（行号排到末尾） */
  async restoreRow(rowId: string): Promise<void> {
    return invoke("row_restore", { rowId });
  },

  /** 彻底删除一行：单元格与行详情文档一并删除，不可恢复 */
  async purgeRow(rowId: string): Promise<void> {
    return invoke("row_purge", { rowId });
  },

  /** 清空本表回收站，返回彻底删除的行数 */
  async purgeTrash(viewId: string): Promise<number> {
    return invoke<number>("row_purge_trash", { viewId });
  },

  /** 超过保留期的行彻底删除（全局小时级清理定时器调用，与页面回收站共用保留天数） */
  async purgeExpiredTrash(deadlineMs: number): Promise<number> {
    return invoke<number>("row_purge_expired_trash", { deadlineMs });
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

  /** 批量写单元格（TSV 粘贴）：嵌套 payload 必须传 snake_case 键（同 csv_import 契约） */
  async setCellsMany(updates: { rowId: string; fieldId: string; value: CellValue }[]): Promise<number> {
    return invoke<number>("cell_set_many", {
      updates: updates.map((u) => ({ row_id: u.rowId, field_id: u.fieldId, value: JSON.stringify(u.value) })),
    });
  },
};
