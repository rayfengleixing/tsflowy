import { NodeViewContent, NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { X, Columns2, Columns3, Columns4 } from "lucide-react";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import type { JSONContent } from "@tiptap/core";

/** 给 columns 容器节点的 NodeView：顶部带切换 2/3/4 列工具栏；子 node 自动用 ColumnNodeView 渲染 */
export function ColumnsNodeView(props: ReactNodeViewProps<HTMLElement>) {
  const { node, editor, deleteNode, getPos } = props;
  const count = node.childCount ?? 1;

  const switchTo = (cols: 2 | 3 | 4) => {
    const posVal = typeof getPos === "function" ? getPos() : undefined;
    if (typeof posVal !== "number" || posVal <= 0) return;
    const current = editor.state.doc.nodeAt(posVal);
    if (!current) return;
    const currentCols: JSONContent[] = [];
    current.forEach((col) => {
      currentCols.push(col.toJSON());
      return false; // continue forEach (return false ≠ break in PM)
    });
    const result: JSONContent[] = [];
    for (let i = 0; i < cols; i++) {
      result.push(
        currentCols[i] ?? {
          type: "column",
          attrs: { ratio: 1 },
          content: [{ type: "paragraph" }],
        },
      );
    }
    const schema = editor.state.schema;
    const colNodes = result.map((c) => schema.nodeFromJSON(c));
    const tr = editor.state.tr.replaceWith(posVal, posVal + current.nodeSize, schema.node("columns", {}, colNodes));
    editor.view.dispatch(tr.scrollIntoView());
  };

  return (
    <NodeViewWrapper
      data-drag-handle
      className={cn(
        "group/cols relative my-3 rounded-lg border border-neutral-200 bg-white p-2",
        props.selected && "ring-2 ring-brand-500",
      )}
    >
      {/* 切换栏数工具栏（悬停显示）*/}
      <div className="absolute right-2 top-2 z-10 hidden items-center gap-0.5 rounded-md border border-neutral-200 bg-white/90 px-1 py-0.5 shadow group-hover/cols:flex">
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => switchTo(2)}
          title={t("columns.to2")}
          className={cn("flex h-6 w-6 items-center justify-center rounded hover:bg-neutral-200", count === 2 && "text-brand-500")}
        ><Columns2 className="h-3.5 w-3.5" /></button>
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => switchTo(3)}
          title={t("columns.to3")}
          className={cn("flex h-6 w-6 items-center justify-center rounded hover:bg-neutral-200", count === 3 && "text-brand-500")}
        ><Columns3 className="h-3.5 w-3.5" /></button>
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => switchTo(4)}
          title={t("columns.to4")}
          className={cn("flex h-6 w-6 items-center justify-center rounded hover:bg-neutral-200", count === 4 && "text-brand-500")}
        ><Columns4 className="h-3.5 w-3.5" /></button>
        <div className="mx-0.5 h-4 w-px bg-neutral-200" />
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => deleteNode()}
          title={t("common.delete")}
          className="flex h-6 w-6 items-center justify-center rounded hover:bg-red-100 text-neutral-500 hover:text-red-600"
        ><X className="h-3.5 w-3.5" /></button>
      </div>

      {/* 子列：TipTap 会自动按 child 顺序调用 ColumnNodeView 填满此处 */}
      <div className="flex w-full gap-4">
        <NodeViewContent className="contents columns-contents-host" />
      </div>
    </NodeViewWrapper>
  );
}

/** 单个栏 NodeView：内放 NodeViewContent 供用户编辑 */
export function ColumnNodeView(_props: ReactNodeViewProps<HTMLElement>) {
  return (
    <NodeViewWrapper
      className={cn(
        "min-w-0 flex-1 rounded-md border border-dashed border-transparent p-1 transition has-[.ProseMirror:empty]:border-neutral-200 hover:border-neutral-200",
      )}
      style={{ minWidth: "0" }}
    >
      <NodeViewContent className="ProseMirror-column-content px-1 py-0.5" />
    </NodeViewWrapper>
  );
}
