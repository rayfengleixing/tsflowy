import type { CellValue, DatabaseField, DatabaseRow, FieldOptions, FieldType } from "@/types/database";
import { getDb, newId } from "./db";
import { defaultOptionsFor, deserializeValue } from "./database-values";

// 数据库三表 CRUD（项目说明书 7 章 DDL / 9.3 节：SQL 集中在 lib 层）
// 行详情文档（database_rows.document_id）由 features/database 层负责创建 view。

const now = () => Date.now();

async function nextPosition(table: "database_fields" | "database_rows", viewId: string): Promise<number> {
  const d = await getDb();
  const rows = await d.select<{ p: number }[]>(
    `SELECT COALESCE(MAX(position), -1) + 1 AS p FROM ${table} WHERE database_view_id = $1`,
    [viewId],
  );
  return rows[0]?.p ?? 0;
}

export const databaseApi = {
  // ---------- 字段 ----------
  async listFields(viewId: string): Promise<DatabaseField[]> {
    const d = await getDb();
    return d.select<DatabaseField[]>(
      "SELECT * FROM database_fields WHERE database_view_id = $1 ORDER BY position ASC",
      [viewId],
    );
  },

  async createField(viewId: string, type: FieldType, name?: string): Promise<DatabaseField> {
    const d = await getDb();
    const id = newId();
    const position = await nextPosition("database_fields", viewId);
    const options = defaultOptionsFor(type);
    await d.execute(
      `INSERT INTO database_fields(id, database_view_id, name, field_type, options, width, is_hidden, position)
       VALUES ($1, $2, $3, $4, $5, 180, 0, $6)`,
      [id, viewId, name ?? type, type, JSON.stringify(options), position],
    );
    return { id, database_view_id: viewId, name: name ?? type, field_type: type, options: JSON.stringify(options), width: 180, is_hidden: 0, position };
  },

  async renameField(fieldId: string, name: string): Promise<void> {
    const d = await getDb();
    await d.execute("UPDATE database_fields SET name = $1 WHERE id = $2", [name, fieldId]);
  },

  async deleteField(fieldId: string): Promise<void> {
    const d = await getDb();
    await d.execute("DELETE FROM database_fields WHERE id = $1", [fieldId]); // cells 级联
  },

  async setFieldWidth(fieldId: string, width: number): Promise<void> {
    const d = await getDb();
    await d.execute("UPDATE database_fields SET width = $1 WHERE id = $2", [width, fieldId]);
  },

  async setFieldHidden(fieldId: string, hidden: boolean): Promise<void> {
    const d = await getDb();
    await d.execute("UPDATE database_fields SET is_hidden = $1 WHERE id = $2", [hidden ? 1 : 0, fieldId]);
  },

  async updateFieldOptions(fieldId: string, options: FieldOptions): Promise<void> {
    const d = await getDb();
    await d.execute("UPDATE database_fields SET options = $1 WHERE id = $2", [JSON.stringify(options), fieldId]);
  },

  /** 整列重排：orderedIds 为最终顺序（position 0..n-1） */
  async reorderFields(viewId: string, orderedIds: string[]): Promise<void> {
    const d = await getDb();
    for (let i = 0; i < orderedIds.length; i++) {
      await d.execute("UPDATE database_fields SET position = $1 WHERE id = $2 AND database_view_id = $3", [i, orderedIds[i], viewId]);
    }
  },

  /** 改字段类型：清空该字段所有单元格值（类型不兼容的数据不可保留） */
  async changeFieldType(fieldId: string, newType: FieldType): Promise<void> {
    const d = await getDb();
    const options = defaultOptionsFor(newType);
    await d.execute(
      "UPDATE database_fields SET field_type = $1, options = $2 WHERE id = $3",
      [newType, JSON.stringify(options), fieldId],
    );
    await d.execute("UPDATE database_cells SET value = 'null' WHERE field_id = $1", [fieldId]);
  },

  // ---------- 行 ----------
  async listRows(viewId: string): Promise<DatabaseRow[]> {
    const d = await getDb();
    return d.select<DatabaseRow[]>(
      "SELECT * FROM database_rows WHERE database_view_id = $1 ORDER BY position ASC",
      [viewId],
    );
  },

  async createRow(viewId: string): Promise<DatabaseRow> {
    const d = await getDb();
    const id = newId();
    const position = await nextPosition("database_rows", viewId);
    const t = now();
    await d.execute(
      "INSERT INTO database_rows(id, database_view_id, position, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)",
      [id, viewId, position, t],
    );
    return { id, database_view_id: viewId, position, document_id: null, created_at: t, updated_at: t };
  },

  /** 按 id 读单个行（行详情重开时需要最新 document_id） */
  async getRow(rowId: string): Promise<DatabaseRow | null> {
    const d = await getDb();
    const rows = await d.select<DatabaseRow[]>("SELECT * FROM database_rows WHERE id = $1", [rowId]);
    return rows[0] ?? null;
  },

  /** 绑定行详情文档 view（首次打开行详情时创建） */
  async setRowDocumentId(rowId: string, documentId: string): Promise<void> {
    const d = await getDb();
    await d.execute("UPDATE database_rows SET document_id = $1 WHERE id = $2", [documentId, rowId]);
  },

  async deleteRow(rowId: string): Promise<void> {
    const d = await getDb();
    await d.execute("DELETE FROM database_rows WHERE id = $1", [rowId]); // cells 级联
  },

  async reorderRows(viewId: string, orderedIds: string[]): Promise<void> {
    const d = await getDb();
    for (let i = 0; i < orderedIds.length; i++) {
      await d.execute("UPDATE database_rows SET position = $1 WHERE id = $2 AND database_view_id = $3", [i, orderedIds[i], viewId]);
    }
  },

  // ---------- 单元格 ----------
  /** 全量读取：rowId → fieldId → 值 */
  async loadCells(viewId: string): Promise<Record<string, Record<string, CellValue>>> {
    const d = await getDb();
    const rows = await d.select<{ row_id: string; field_id: string; value: string }[]>(
      `SELECT c.row_id, c.field_id, c.value
       FROM database_cells c
       JOIN database_rows r ON r.id = c.row_id
       WHERE r.database_view_id = $1`,
      [viewId],
    );
    const out: Record<string, Record<string, CellValue>> = {};
    for (const row of rows) {
      (out[row.row_id] ??= {})[row.field_id] = deserializeValue("text", row.value);
    }
    return out;
  },

  async setCell(rowId: string, fieldId: string, value: CellValue): Promise<void> {
    const d = await getDb();
    await d.execute(
      `INSERT INTO database_cells(row_id, field_id, value) VALUES ($1, $2, $3)
       ON CONFLICT(row_id, field_id) DO UPDATE SET value = $3`,
      [rowId, fieldId, JSON.stringify(value)],
    );
  },
};