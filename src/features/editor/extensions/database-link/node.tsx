import { mergeAttributes, Node } from "@tiptap/core";
import { ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { Table2 } from "lucide-react";
import { useWorkspaceStore } from "@/stores/workspace";

/**
 * 数据库表链接节点（内联）：
 * 在文档中插入一个可点击的引用卡片，点击后跳转到对应 grid/board 视图。
 * 与 databaseView（完整嵌入表格）不同，此节点仅显示图标 + 名称链接。
 */
function DatabaseLinkView({ node, deleteNode }: NodeViewProps) {
  const openView = useWorkspaceStore((s) => s.openView);
  const viewId = node.attrs.viewId as string;
  const name = (node.attrs.name as string) || "Untitled table";

  return (
    <span
      className="inline-flex items-center gap-1 rounded-md border border-brand-200 bg-brand-50 px-1.5 py-0.5 text-[13px] text-brand-700 align-middle cursor-pointer hover:bg-brand-100 hover:border-brand-300 transition"
      contentEditable={false}
      onClick={(e) => {
        e.preventDefault();
        if (viewId) openView(viewId);
      }}
    >
      <Table2 className="h-3.5 w-3.5 shrink-0" />
      <span className="max-w-[200px] truncate">{name}</span>
      <button
        className="ml-0.5 flex h-3.5 w-3.5 items-center justify-center rounded text-brand-400 hover:bg-brand-200 hover:text-brand-700"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          deleteNode();
        }}
        title="移除链接"
      >
        ✕
      </button>
    </span>
  );
}

export const DatabaseLink = Node.create({
  name: "databaseLink",

  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      viewId: { default: null },
      name: { default: "" },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-database-link]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes({ "data-database-link": "" }, HTMLAttributes)];
  },

  addNodeView() {
    return ReactNodeViewRenderer(DatabaseLinkView);
  },
});
