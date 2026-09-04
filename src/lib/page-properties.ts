// 页面属性 API（Phase 4.2 - Page Properties）
//
// 文档顶部 chips：text/date/single_select/multi_select/number/checkbox。
// 所有写操作 upsert（PRIMARY KEY (view_id,key)），读操作按 position ASC 排序。
import { getDb, runInTransaction } from "./db";

export type PagePropertyFieldType =
  | "text"
  | "date"
  | "single_select"
  | "multi_select"
  | "number"
  | "checkbox";

export interface PagePropertyRow {
  view_id: string;
  key: string;
  /** value：text=原文；date=YYYY-MM-DD；single=选项名；multi=JSON数组字符串；number=数字字符串；checkbox='1'/'0' */
  value: string;
  field_type: PagePropertyFieldType;
  position: number;
}

const TABLE = "page_properties";

/** view 全部属性，按 position 排序 */
export const pagePropertiesApi = {
  async list(viewId: string): Promise<PagePropertyRow[]> {
    const d = await getDb();
    return d.select<PagePropertyRow[]>(
      `SELECT * FROM ${TABLE} WHERE view_id = $1 ORDER BY position ASC`,
      [viewId],
    );
  },

  async set(
    viewId: string,
    key: string,
    value: string,
    fieldType: PagePropertyFieldType,
  ): Promise<void> {
    const d = await getDb();
    // 先查 position（存在保留原值；不存在则取 MAX+1）
    const existing = await d.select<{ position: number }[]>(
      `SELECT position FROM ${TABLE} WHERE view_id = $1 AND key = $2`,
      [viewId, key],
    );
    if (existing.length > 0) {
      await d.execute(
        `UPDATE ${TABLE} SET value = $1, field_type = $2 WHERE view_id = $3 AND key = $4`,
        [value, fieldType, viewId, key],
      );
    } else {
      const rows = await d.select<{ p: number }[]>(
        `SELECT COALESCE(MAX(position), -1) + 1 AS p FROM ${TABLE} WHERE view_id = $1`,
        [viewId],
      );
      const position = rows[0]?.p ?? 0;
      await d.execute(
        `INSERT INTO ${TABLE}(view_id, key, value, field_type, position) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT(view_id, key) DO UPDATE SET value = excluded.value, field_type = excluded.field_type`,
        [viewId, key, value, fieldType, position],
      );
    }
  },

  async remove(viewId: string, key: string): Promise<void> {
    const d = await getDb();
    await d.execute(`DELETE FROM ${TABLE} WHERE view_id = $1 AND key = $2`, [viewId, key]);
    // 删除后重新紧凑 position（gaps 保留也可，但为了 UI 顺序稳定，把后续项减 1）
    await d.execute(
      `UPDATE ${TABLE} SET position = position - 1 WHERE view_id = $1 AND position > (
         SELECT COALESCE((SELECT position FROM ${TABLE} WHERE view_id = $1 AND key = $2), -1)
       )`,
      [viewId, key],
    );
  },

  async rename(viewId: string, oldKey: string, newKey: string): Promise<void> {
    if (!newKey.trim() || oldKey === newKey) return;
    const d = await getDb();
    await runInTransaction(async () => {
      // 若 newKey 已存在（冲突）→ 与旧值合并（覆盖 value/type，删除 oldKey）
      const target = await d.select<PagePropertyRow[]>(
        `SELECT * FROM ${TABLE} WHERE view_id = $1 AND key = $2`,
        [viewId, newKey],
      );
      if (target.length > 0) {
        // 删除旧 key，冲突保留目标（语义：重命名等于删旧建新，目标优先）
        await d.execute(`DELETE FROM ${TABLE} WHERE view_id = $1 AND key = $2`, [viewId, oldKey]);
      } else {
        await d.execute(
          `UPDATE ${TABLE} SET key = $1 WHERE view_id = $2 AND key = $3`,
          [newKey.trim(), viewId, oldKey],
        );
      }
    });
  },
};
