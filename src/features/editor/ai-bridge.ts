// EditorPage 的 AI 助手桥接：供 AI 面板取当前页/选区文本、回填内容、按锚点改写文档。
// 原来是宿主里一段 172 行的 useEffect 体，只吃两个输入（编辑器实例与页面标题），
// 登记与卸载（registerAiEditor / registerAiEditorForView、依赖数组）仍留在宿主，形制对齐 grid-io-slice.ts。
import { Slice, Fragment, Node as PMNode } from "@tiptap/pm/model";
import type { Editor } from "@tiptap/core";
import { looksLikeMarkdown, markdownToJson, textToBlocks } from "@/lib/markdown";
import type { AiEditorBridge } from "@/lib/ai/ai-editor";
import { STRUCTURE_SYNC_META } from "./extensions/document-structure-lock";
import { logger } from "@/lib/logger";
import { t } from "@/lib/i18n";

export interface AiBridgeDeps {
  /** 当前页的编辑器：effect 已确认未销毁才建桥 */
  editor: Editor;
  /** 页面标题：getPageTitle 读它，宿主按 view.name 传进来并留在依赖数组里 */
  viewName: string;
}

export function createAiEditorBridge({ editor, viewName }: AiBridgeDeps): AiEditorBridge {
  // 回填文本 → ProseMirror 节点：含 markdown 结构（# 标题 / - 列表 / ``` 围栏…）时走
  // markdownToJson，否则按行拆段落保留换行。复用粘贴的转换逻辑，避免把 **粗体**、- 列表
  // 这类标记原样落成字面文本，也避免多段被合并成一段。
  const toSlice = (text: string): Slice | null => {
    try {
      const json = looksLikeMarkdown(text) ? markdownToJson(text) : textToBlocks(text);
      const nodes = (json.content ?? []).map((b) => PMNode.fromJSON(editor.state.schema, b));
      return nodes.length === 0 ? null : new Slice(Fragment.fromArray(nodes), 0, 0);
    } catch (e) {
      logger.error("ai write-back convert failed", e);
      return null;
    }
  };
  // 顶层块带位置快照：两类定位都要按绝对位置切范围，逐个 forEach 累加容易错位
  const topBlocks = () => {
    const doc = editor.state.doc;
    const out: { node: PMNode; from: number; to: number }[] = [];
    let pos = 0;
    doc.forEach((node) => {
      out.push({ node, from: pos, to: pos + node.nodeSize });
      pos += node.nodeSize;
    });
    return out;
  };
  // 定位工具：按标题文本找小节（标题之后、下一个同级或更高标题之前的范围）
  const locateHeadingSection = (heading: string): { start: number; end: number; index: number } | null => {
    const doc = editor.state.doc;
    const norm = (s: string) =>
      s
        .replace(/^[#*\s]+/, "")
        .replace(/[*\s]+$/, "")
        .trim();
    const wanted = norm(heading);
    if (!wanted) return null;
    const blocks = topBlocks();
    const i = blocks.findIndex((b) => b.node.type.name === "heading" && norm(b.node.textContent) === wanted);
    if (i === -1) return null;
    const level = Number((blocks[i].node.attrs as { level?: number }).level ?? 1);
    const next = blocks.slice(i + 1).find((b) => {
      if (b.node.type.name !== "heading") return false;
      return Number((b.node.attrs as { level?: number }).level ?? 1) <= level;
    });
    return { start: blocks[i].to, end: next ? next.from : doc.content.size, index: i };
  };
  // 定位工具：找一段文字在文档中的精确范围。只在单个顶层块内匹配（跨块语义不清宁可失败），
  // 命中位置按 text 节点累加得出，避免带标记/内联节点的段落字符偏移错位。
  const locateTextRange = (text: string): { from: number; to: number; index: number } | null => {
    if (!text) return null;
    const blocks = topBlocks();
    for (let i = 0; i < blocks.length; i++) {
      const { node, from } = blocks[i];
      // 空分隔符：纯文本拼接，与下面的 text 节点游走口径一致
      const joined = node.textBetween(0, node.content.size, "", "");
      const rel = joined.indexOf(text);
      if (rel === -1) continue;
      let acc = 0;
      let hit = -1;
      node.descendants((child, innerPos) => {
        if (hit !== -1) return false;
        if (!child.isText || !child.text) return true;
        const len = child.text.length;
        if (acc + len > rel) {
          hit = from + 1 + innerPos + (rel - acc);
          return false;
        }
        acc += len;
        return false;
      });
      if (hit !== -1) return { from: hit, to: hit + text.length, index: i };
    }
    return null;
  };
  const bridge: AiEditorBridge = {
    getPageText: () => (editor.isDestroyed ? "" : editor.state.doc.textBetween(0, editor.state.doc.content.size, "\n")),
    getPageTitle: () => (editor.isDestroyed ? "" : viewName),
    getSelectionText: () => {
      if (editor.isDestroyed) return "";
      const { from, to } = editor.state.selection;
      return from === to ? "" : editor.state.doc.textBetween(from, to, "\n");
    },
    // diff 预览的「原文」：替换类指令有被覆盖的原文，插入/追加类没有
    getEditTargetText: (op, anchor) => {
      if (editor.isDestroyed) return "";
      if (op === "replace_text") {
        const hit = anchor?.text ? locateTextRange(anchor.text) : null;
        return hit ? editor.state.doc.textBetween(hit.from, hit.to, "\n") : "";
      }
      if (op === "replace_under_heading") {
        const sec = locateHeadingSection(anchor?.heading ?? "");
        return sec && sec.end > sec.start ? editor.state.doc.textBetween(sec.start, sec.end, "\n") : "";
      }
      if (op !== "replace_selection") return "";
      const { from, to } = editor.state.selection;
      return from === to ? "" : editor.state.doc.textBetween(from, to, "\n");
    },
    replaceSelection: (text) => {
      if (editor.isDestroyed) return;
      const slice = toSlice(text);
      // 转换失败时退化为纯文本插入，宁可丢格式也不要什么都不发生
      const tr = slice ? editor.state.tr.replaceSelection(slice) : editor.state.tr.insertText(text);
      editor.view.dispatch(tr.scrollIntoView());
      editor.view.focus();
    },
    insertAtCursor: (text) => {
      if (editor.isDestroyed) return;
      const slice = toSlice(text);
      const pos = editor.state.selection.from;
      const tr = slice ? editor.state.tr.replaceRange(pos, pos, slice) : editor.state.tr.insertText(text, pos);
      editor.view.dispatch(tr.scrollIntoView());
      editor.view.focus();
    },
    // AI 自主修改：按 op 决定改写范围，定位类 op 先按锚点找目标，直接落到文档上
    applyEdit: (op, markdown, anchor) => {
      if (editor.isDestroyed) return { applied: false };
      const slice = toSlice(markdown);
      if (!slice) return { applied: false };
      const { doc, selection } = editor.state;
      let range: { from: number; to: number } | null = null;
      if (op === "insert_under_heading" || op === "replace_under_heading") {
        const sec = locateHeadingSection(anchor?.heading ?? "");
        if (!sec) return { applied: false, reason: t("ai.locateHeadingNotFound") };
        if (sec.index === 0) return { applied: false, reason: t("ai.locateProtectedHeading") };
        range = op === "insert_under_heading" ? { from: sec.end, to: sec.end } : { from: sec.start, to: sec.end };
      } else if (op === "replace_text") {
        const hit = anchor?.text ? locateTextRange(anchor.text) : null;
        if (!hit) return { applied: false, reason: t("ai.locateTextNotFound") };
        if (hit.index === 0) return { applied: false, reason: t("ai.locateProtectedHeading") };
        range = { from: hit.from, to: hit.to };
      } else {
        range =
          op === "append_to_document"
            ? { from: doc.content.size, to: doc.content.size }
            : op === "insert_at_cursor"
              ? { from: selection.from, to: selection.from }
              : // replace_selection：无选区时退化为在光标处插入，与「替换选中」按钮一致
                { from: selection.from, to: selection.to };
      }
      const before = editor.state.doc;
      editor.view.dispatch(editor.state.tr.replaceRange(range.from, range.to, slice).scrollIntoView());
      editor.view.focus();
      // 结构锁定（首行标题/第二行分割线）会拦掉落在保护区里的事务：据实回报是否真的改了
      if (editor.state.doc.eq(before)) return { applied: false, reason: t("ai.locateBlockedByLock") };
      // 留下改前快照作为撤销凭据：撤销时据此判断「撤掉的到底是不是这次改动」
      return { applied: true, revert: { before: before.toJSON() } };
    },
    undoAiEdit: (revert) => {
      if (editor.isDestroyed || !revert) return false;
      let beforeNode;
      try {
        beforeNode = PMNode.fromJSON(editor.state.schema, revert.before);
      } catch (e) {
        logger.error("ai undo: snapshot invalid", e);
        return false;
      }
      // 试探性撤销：先撤一步，若正好回到 AI 改动前的快照，说明撤掉的就是这次改动。
      // 否则这一步撤的是用户后来的编辑，立刻 redo 复原，绝不静默丢弃用户内容。
      const current = editor.state.doc;
      editor.commands.undo();
      if (beforeNode.eq(editor.state.doc)) return true;
      editor.commands.redo();
      if (!editor.state.doc.eq(current)) {
        // redo 没能复原（撤销栈被清空等极端情况）：整体写回原文兜底。
        // 必须带 STRUCTURE_SYNC_META：不带的话，写回文档首块的结构事务会被结构锁定
        // filterTransaction 拒掉，兜底形同虚设，用户内容就停在错的状态上。
        const tr = editor.state.tr.replaceWith(0, editor.state.doc.content.size, current.content);
        tr.setMeta(STRUCTURE_SYNC_META, true);
        editor.view.dispatch(tr);
      }
      return false;
    },
  };
  return bridge;
}
