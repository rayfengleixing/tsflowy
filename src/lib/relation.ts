import { databaseApi } from "./database";
import { formatCellValue, parseFieldOptions } from "./database-values";

// 关联字段：加载目标表格的行 + 首列文本（项目说明书 5.1 关联：同库行，存对端 row_id）

export interface RelationRow {
  id: string;
  label: string;
}

/** 取目标库视图的首列文本作为行标签 */
export async function getTargetRows(targetViewId: string): Promise<RelationRow[]> {
  try {
    const [fields, rows, cells] = await Promise.all([
      databaseApi.listFields(targetViewId),
      databaseApi.listRows(targetViewId),
      databaseApi.loadCells(targetViewId),
    ]);
    const primary = fields.find((f) => f.is_hidden === 0) ?? fields[0];
    if (!primary) return rows.map((r) => ({ id: r.id, label: "行 " + (r.position + 1) }));
    return rows.map((r) => {
      const label = formatCellValue(primary.field_type, cells[r.id]?.[primary.id] ?? null, parseFieldOptions(primary.options));
      return { id: r.id, label: (label || "行 " + (r.position + 1)).slice(0, 40) };
    });
  } catch (e) {
    console.error("load target rows failed", targetViewId, e);
    return [];
  }
}

/** 把对端 row_id 列表转成标签（编辑/显示共用；目标库不可用时退回 id） */
export function relationLabels(rows: RelationRow[], ids: string[]): string[] {
  return ids.map((id) => rows.find((r) => r.id === id)?.label ?? id);
}
