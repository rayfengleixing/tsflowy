import { useEffect, useRef } from "react";
import { NodeViewContent, NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { X, Columns2, Columns3, Columns4, StretchHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import type { JSONContent } from "@tiptap/core";
import {
  buildRatiosTr,
  columnIndexOf,
  columnsAncestorPos,
  evenRatios,
  normalizeRatio,
  readRatios,
  shiftRatios,
} from "./ratio";

/** 给 columns 容器节点的 NodeView：顶部带切换 2/3/4 列工具栏；子 node 自动用 ColumnNodeView 渲染 */
export function ColumnsNodeView(props: ReactNodeViewProps<HTMLElement>) {
  const { node, editor, deleteNode, getPos } = props;
  const count = node.childCount;

  const switchTo = (cols: 2 | 3 | 4) => {
    const posVal = typeof getPos === "function" ? getPos() : undefined;
    // pos 0 是合法位置（无结构锁定的历史文档里 columns 可能就是首块）
    if (typeof posVal !== "number" || posVal < 0) return;
    const current = editor.state.doc.nodeAt(posVal);
    if (!current) return;
    if (current.type.name !== "columns") return;
    const currentCols: JSONContent[] = [];
    current.forEach((col) => {
      currentCols.push(col.toJSON() as JSONContent);
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
    // 减列不丢内容：溢出列的块并入最后一列，否则用户列里的段落凭空蒸发
    for (let i = cols; i < currentCols.length; i++) {
      const overflow = currentCols[i];
      const last = result[cols - 1];
      const kept = Array.isArray(last.content) ? last.content : [];
      const extra = Array.isArray(overflow.content) ? overflow.content : [];
      last.content = [...kept, ...extra];
    }
    const schema = editor.state.schema;
    const colNodes = result.map((c) => schema.nodeFromJSON(c));
    const tr = editor.state.tr.replaceWith(posVal, posVal + current.nodeSize, schema.node("columns", {}, colNodes));
    editor.view.dispatch(tr.scrollIntoView());
  };

  /** 均分列宽：把每列 ratio 拉回 1（拖动过的分隔条位置重新等分） */
  const evenWidths = () => {
    const posVal = typeof getPos === "function" ? getPos() : undefined;
    if (typeof posVal !== "number" || posVal < 0) return;
    const ratios = readRatios(editor.state.doc, posVal);
    if (!ratios) return;
    const tr = buildRatiosTr(editor.state, posVal, evenRatios(ratios.length));
    if (tr) editor.view.dispatch(tr);
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
          className={cn(
            "flex h-6 w-6 items-center justify-center rounded hover:bg-neutral-200",
            count === 2 && "text-brand-500",
          )}
        >
          <Columns2 className="h-3.5 w-3.5" />
        </button>
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => switchTo(3)}
          title={t("columns.to3")}
          className={cn(
            "flex h-6 w-6 items-center justify-center rounded hover:bg-neutral-200",
            count === 3 && "text-brand-500",
          )}
        >
          <Columns3 className="h-3.5 w-3.5" />
        </button>
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => switchTo(4)}
          title={t("columns.to4")}
          className={cn(
            "flex h-6 w-6 items-center justify-center rounded hover:bg-neutral-200",
            count === 4 && "text-brand-500",
          )}
        >
          <Columns4 className="h-3.5 w-3.5" />
        </button>
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={evenWidths}
          title={t("columns.even")}
          className="flex h-6 w-6 items-center justify-center rounded hover:bg-neutral-200"
        >
          <StretchHorizontal className="h-3.5 w-3.5" />
        </button>
        <div className="mx-0.5 h-4 w-px bg-neutral-200" />
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => deleteNode()}
          title={t("common.delete")}
          className="flex h-6 w-6 items-center justify-center rounded hover:bg-red-100 text-neutral-500 hover:text-red-600"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* 子列：TipTap 会自动按 child 顺序调用 ColumnNodeView 填满此处 */}
      <div className="flex w-full gap-4">
        <NodeViewContent className="contents columns-contents-host" />
      </div>
    </NodeViewWrapper>
  );
}

/** 单个栏 NodeView：宽度由 column.ratio 决定，左边缘的分隔条可拖动改相邻两列的比例 */
export function ColumnNodeView(props: ReactNodeViewProps<HTMLElement>) {
  const wrapRef = useRef<HTMLElement | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const ratio = normalizeRatio(props.node.attrs.ratio);

  // 拖到一半组件被卸载（切列数、删块）也要摘掉 window 监听
  useEffect(() => () => cleanupRef.current?.(), []);

  /** 拖动左边缘分隔条：只影响本列与左邻列，松手时一次性提交（一次拖拽 = 一条撤销记录） */
  const startResize = (event: React.MouseEvent) => {
    if (event.button !== 0) return;
    event.preventDefault(); // 别抢走单元格里正在编辑的文本选区
    const wrap = wrapRef.current;
    const row = wrap?.parentElement;
    if (!wrap || !row) return;
    const rowWidth = row.getBoundingClientRect().width;
    if (rowWidth <= 0) return;
    const pos = typeof props.getPos === "function" ? props.getPos() : undefined;
    if (typeof pos !== "number" || pos < 0) return;
    const doc = props.editor.view.state.doc;
    const columnsPos = columnsAncestorPos(doc, pos);
    if (columnsPos === null) return;
    const index = columnIndexOf(doc, columnsPos, pos);
    if (index === null || index < 1) return; // 第一列左侧没有可拖的边界
    const base = readRatios(doc, columnsPos);
    if (!base) return;
    const startX = event.clientX;
    const prev = row.children[index - 1] as HTMLElement | undefined;
    let latest: number[] | null = null;
    const apply = (ratios: number[]) => {
      if (prev) prev.style.flex = `${ratios[index - 1]} 1 0%`;
      wrap.style.flex = `${ratios[index]} 1 0%`;
    };
    const onMove = (moveEvent: MouseEvent) => {
      const next = shiftRatios(base, index, (moveEvent.clientX - startX) / rowWidth);
      if (!next) return;
      latest = next;
      // 拖动过程直接改 DOM，避免每帧派发事务把历史栈灌满
      apply(next);
    };
    const onUp = () => {
      cleanupRef.current?.();
      const applied = latest;
      if (!applied) return;
      const tr = buildRatiosTr(props.editor.view.state, columnsPos, applied);
      // 事务被拒（文档在拖动期间变了）就把 DOM 收回真实比例，别留下假宽度
      if (tr) props.editor.view.dispatch(tr);
      else apply(base);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    cleanupRef.current = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      cleanupRef.current = null;
    };
  };

  return (
    <NodeViewWrapper
      ref={wrapRef}
      data-column=""
      className={cn(
        "min-w-0 rounded-md border border-dashed border-transparent p-1 transition has-[.ProseMirror:empty]:border-neutral-200 hover:border-neutral-200",
      )}
      style={{ flex: `${ratio} 1 0%`, minWidth: "0" }}
    >
      <div
        contentEditable={false}
        className="column-grip"
        title={t("columns.resize")}
        onMouseDown={startResize}
        aria-hidden="true"
      />
      <NodeViewContent className="ProseMirror-column-content px-1 py-0.5" />
    </NodeViewWrapper>
  );
}
