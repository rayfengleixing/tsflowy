// 容器块「转为文本」的展开逻辑（纯函数，与 block-menu 的 UI 解耦以便测试）。
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { JSONContent } from "@tiptap/core";

/**
 * 把容器节点（blockquote/callout/toggle/columns/列表/表格…）展开为顶层块 JSON 数组：
 *   - 文本块（段落/标题/代码块…）整块保留：行内 marks、硬换行、原子 inline 节点
 *     （image/mention 等）原样带走，不再像旧实现那样压成纯文本；
 *   - 其余容器（列表外壳、listItem、表格行/单元格、栏…）递归展开，外壳丢弃；
 *   - 无法作为正文的 atom 块级节点（block image/databaseView 等）跳过；
 *   - 一个都没展开出来时补一个空段落，保证插入后文档合法。
 */
export function expandContainerToTextBlocks(node: ProseMirrorNode): JSONContent[] {
  const out: JSONContent[] = [];
  const visit = (n: ProseMirrorNode) => {
    if (n.isTextblock) {
      out.push(n.toJSON() as JSONContent);
      return;
    }
    if (n.isAtom) return;
    n.forEach(visit);
  };
  node.forEach(visit);
  if (out.length === 0) out.push({ type: "paragraph" });
  return out;
}
