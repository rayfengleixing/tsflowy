import { useMemo } from "react";
import Mention from "@tiptap/extension-mention";
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from "@tiptap/react";
import { useWorkspaceStore } from "@/stores/workspace";
import { resolveMentionName } from "@/lib/mentions";
import { t } from "@/lib/i18n";

// 渲染态 mention 节点视图：显示名按目标 id 从实时页面树解析（重命名立即反映），
// 树中查不到（页面已删除/离线场景）回落插入时的 attrs.label 快照。
// DOM 契约保持不变：.mention 类 + data-id（EditorPage hover 预览靠它们定位）。
function MentionNodeView(props: ReactNodeViewProps<HTMLElement>) {
  const { node, extension } = props;
  const tree = useWorkspaceStore((s) => s.tree);
  const id = typeof node.attrs.id === "string" ? node.attrs.id : "";
  const label = typeof node.attrs.label === "string" ? node.attrs.label : "";
  const display = useMemo(() => resolveMentionName(tree, id, label, t("common.untitled")), [tree, id, label]);
  const optionClass = (extension.options as { HTMLAttributes?: { class?: string } }).HTMLAttributes?.class ?? "mention";
  return (
    <NodeViewWrapper as="span" className={optionClass} data-id={id} data-label={label} data-type="mention">
      {display}
    </NodeViewWrapper>
  );
}

// Mention 默认渲染是插入时的 label 快照；套一层 node view 改为渲染态解析。
// HTMLAttributes/suggestion 仍由调用方 configure 传入（renderHTML 序列化路径不受影响）。
export const LiveMention = Mention.extend({
  addNodeView() {
    return ReactNodeViewRenderer(MentionNodeView);
  },
});
