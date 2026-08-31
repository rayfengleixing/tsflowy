import { useEffect, useState } from "react";
import { ExternalLink, Table2 } from "lucide-react";
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import type { DatabaseField, DatabaseRow, CellValue } from "@/types/database";
import { databaseApi } from "@/lib/database";
import { formatCellValue, parseFieldOptions } from "@/lib/database-values";
import { useWorkspaceStore } from "@/stores/workspace";

// databaseView 只读渲染：加载目标视图的字段/行/单元格，展示前若干行
export function DatabaseViewNodeView(props: ReactNodeViewProps<HTMLElement>) {
  const { node, selected } = props;
  const openView = useWorkspaceStore((s) => s.openView);
  const viewId = node.attrs.viewId as string | null;
  const [fields, setFields] = useState<DatabaseField[]>([]);
  const [rows, setRows] = useState<DatabaseRow[]>([]);
  const [cells, setCells] = useState<Record<string, Record<string, CellValue>>>({});

  useEffect(() => {
    let alive = true;
    if (!viewId) {
      setFields([]);
      setRows([]);
      setCells({});
      return;
    }
    Promise.all([databaseApi.listFields(viewId), databaseApi.listRows(viewId), databaseApi.loadCells(viewId)])
      .then(([f, r, c]) => {
        if (alive) {
          setFields(f.filter((x) => x.is_hidden === 0));
          setRows(r.slice(0, 8));
          setCells(c);
        }
      })
      .catch((e) => console.error("load embedded db failed", viewId, e));
    return () => {
      alive = false;
    };
  }, [viewId]);

  if (!viewId) {
    return (
      <NodeViewWrapper className="my-3 rounded-lg border border-neutral-300 p-3 text-[13px] text-neutral-400" data-drag-handle>
        数据库视图（未选择）
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper data-drag-handle className={"my-3 overflow-hidden rounded-lg border border-neutral-300 " + (selected ? "ring-2 ring-brand-500" : "")}>
      <div className="flex items-center gap-2 border-b border-neutral-200 bg-neutral-100/70 px-3 py-2">
        <Table2 className="h-4 w-4 text-neutral-500" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-neutral-800">{(node.attrs.name as string | undefined) || "数据库"}</span>
        <button
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[12px] text-brand-600 hover:bg-brand-100"
          onClick={() => viewId && openView(viewId)}
        >
          <ExternalLink className="h-3.5 w-3.5" />
          打开
        </button>
      </div>
      {fields.length === 0 ? (
        <div className="px-3 py-4 text-center text-[12px] text-neutral-400">目标视图暂无字段</div>
      ) : (
        <table className="w-full border-collapse">
          <thead>
            <tr>
              {fields.map((f) => (
                <th key={f.id} className="border-b border-r border-neutral-200 bg-neutral-100/50 px-2 py-1 text-left text-[11px] font-medium text-neutral-500">
                  {f.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={fields.length} className="px-2 py-3 text-center text-[12px] text-neutral-400">
                  暂无数据
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id}>
                {fields.map((f) => (
                  <td key={f.id} className="max-w-[180px] truncate border-b border-r border-neutral-200 px-2 py-1 text-[12px] text-neutral-700">
                    {formatCellValue(f.field_type, cells[r.id]?.[f.id] ?? null, parseFieldOptions(f.options))}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </NodeViewWrapper>
  );
}