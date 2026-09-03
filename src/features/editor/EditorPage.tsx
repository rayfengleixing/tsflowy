import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import Highlight from "@tiptap/extension-highlight";
import TextAlign from "@tiptap/extension-text-align";
import { TextStyle } from "@tiptap/extension-text-style";
import Color from "@tiptap/extension-color";
import CharacterCount from "@tiptap/extension-character-count";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableCell } from "@tiptap/extension-table-cell";
import { type JSONContent } from "@tiptap/core";
import { Slice, Fragment, Node as PMNode } from "@tiptap/pm/model";
import { toast } from "sonner";
import { viewIcon } from "@/components/view-icon";
import { useWorkspaceStore } from "@/stores/workspace";
import { documentApi } from "@/lib/documents";
import { looksLikeMarkdown, markdownToJson, textToBlocks } from "@/lib/markdown";
import { t } from "@/lib/i18n";
import type { View } from "@/types/models";
import { SlashMenu } from "./slash-menu";
import { TableContextMenu } from "./table-context-menu";
import { FloatingMenu } from "./floating-menu";
import { Image } from "./extensions/image/node";
import { DatabaseView } from "./extensions/database-view/node";
import { Attachment } from "./extensions/attachment/node";
import { CodeBlock } from "./extensions/code-block/index";
// — M3 高级块（按步骤逐个引入，见实现计划）—
import { Math } from "./extensions/math/node";
import { Callout } from "./extensions/callout/node";
import { Toggle } from "./extensions/toggle/node";
import { Outline } from "./extensions/outline/node";
import { Columns, Column } from "./extensions/columns/node";
import { ImageGallery } from "./extensions/image-gallery/node";
import Mention from "@tiptap/extension-mention";
import { buildMentionSuggestion } from "./extensions/mention/suggestion";
// — M3 高级块结束 —
import "highlight.js/styles/github.css";

const AUTOSAVE_MS = 800;

// 表格单元格默认居中（tiptap v3 表格原生支持 align 属性，导出/粘贴可保留）
const centeredCellAttrs = () => ({
  align: {
    default: "center",
    parseHTML: (el: HTMLElement) => {
      const v = (el.style?.textAlign || el.getAttribute("align") || "").trim().toLowerCase();
      return v === "left" || v === "center" || v === "right" ? v : "center";
    },
    renderHTML: (attrs: Record<string, unknown>) => (attrs.align ? { style: `text-align: ${attrs.align}` } : {}),
  },
});
const CenteredTableCell = TableCell.extend({
  addAttributes() {
    return { ...this.parent?.(), ...centeredCellAttrs() };
  },
});
const CenteredTableHeader = TableHeader.extend({
  addAttributes() {
    return { ...this.parent?.(), ...centeredCellAttrs() };
  },
});

// Markdown 符号输入规则由内置扩展自带：**粗体** / *斜体* / ==高亮== / ~~删除线~~ / `代码`
// （@tiptap/extension-bold·italic·strike·highlight·code 的 addInputRules 已注册，无需自定义）


/** 文档编辑器页（项目说明书 8.1：读 content → 编辑 → 防抖 800ms 落库 → 切换/关闭前 flush） */
export function EditorPage({ view, hideTitle = false, hideSlash = false }: { view: View; hideTitle?: boolean; hideSlash?: boolean }) {
  const renameView = useWorkspaceStore((s) => s.renameView);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(view.name);

  const editorRef = useRef<ReturnType<typeof useEditor>>(null);
  const dirtyRef = useRef(false);
  const saveTimer = useRef<number | null>(null);
  const latestJsonRef = useRef<JSONContent | null>(null);

  const flush = useCallback(() => {
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    // 用缓存的最新 JSON 落库：卸载时 editor 可能已被销毁，不能依赖 editor 实例
    if (!dirtyRef.current || !latestJsonRef.current) return;
    dirtyRef.current = false;
    const json = latestJsonRef.current;
    latestJsonRef.current = null;
    documentApi.save(view.id, JSON.stringify(json)).catch((e) => {
      console.error("autosave failed", view.id, e);
      toast.error(t("error.saveDoc", { message: String(e) }));
    });
  }, [view.id]);

  const scheduleSave = useCallback(() => {
    const editor = editorRef.current;
    if (!editor || editor.isDestroyed) return;
    latestJsonRef.current = editor.getJSON();
    dirtyRef.current = true;
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(flush, AUTOSAVE_MS);
  }, [flush]);

  // 单文档编辑互斥：只有当前标签页挂载编辑器，切换/关闭即卸载并 flush
  // extensions 数组需稳定引用（useEditor 按引用比较），否则每次渲染都会 setOptions
  const extensions = useMemo(
    () => [
      StarterKit.configure({
        link: { openOnClick: false, autolink: true },
        codeBlock: false,
        heading: { levels: [1, 2, 3] },
      }),
      CodeBlock,
      Placeholder.configure({
        placeholder: ({ node }) =>
          node.type.name === "heading"
            ? t("editor.placeholderHeading")
            : hideSlash
              ? t("editor.placeholderNoSlash")
              : t("editor.placeholder"),
        emptyEditorClass: "is-editor-empty",
        emptyNodeClass: "is-empty",
      }),
      Highlight.configure({ multicolor: true }),
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      TextStyle,
      Color,
      CharacterCount,
      TaskList,
      TaskItem.configure({ nested: true }),
      Table.configure({ resizable: true }),
      TableRow,
      CenteredTableHeader,
      CenteredTableCell,
      Image,
      DatabaseView,
      Attachment,
      // — M3 高级块（注册顺序不敏感，mention 是 mark，其余是 node）—
      Math,
      Callout,
      Toggle,
      Outline,
      Columns,
      Column,
      ImageGallery,
      Mention.configure({
        HTMLAttributes: { class: "mention cursor-pointer underline decoration-dotted underline-offset-2 text-brand-600 hover:text-brand-700" },
        suggestion: buildMentionSuggestion(),
      }),
      // — M3 高级块结束 —
      ...(hideSlash ? [] : [SlashMenu]),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hideSlash],
  );

  const editor = useEditor({
    extensions,
    content: { type: "doc", content: [] },
    editorProps: {
      attributes: { class: "tiptap focus:outline-none" },
      handleKeyDown: (_view, event) => {
        const metaOrCtrl = event.ctrlKey || event.metaKey;
        // — 快捷键 1：Ctrl+S 手动保存 —
        if (metaOrCtrl && event.key.toLowerCase() === "s") {
          event.preventDefault();
          flush();
          toast.success(t("editor.saved"));
          return true;
        }
        // — M6 修复 5：Ctrl+T 插入 3×3 表格（带表头）—
        if (metaOrCtrl && event.key.toLowerCase() === "t") {
          event.preventDefault();
          if (editorRef.current && !editorRef.current.isDestroyed) {
            editorRef.current
              .chain()
              .focus()
              .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
              .run();
          }
          return true;
        }
        // — M6 修复 5：Ctrl+L 切换任务列表（段落↔任务项）—
        if (metaOrCtrl && event.key.toLowerCase() === "l") {
          event.preventDefault();
          if (editorRef.current && !editorRef.current.isDestroyed) {
            editorRef.current.chain().focus().toggleTaskList().run();
          }
          return true;
        }
        return false;
      },
      // 输入空格后清除格式：粗体/高亮只作用于被选中的文字，后续输入不延续
      // （storedMarks = 切换格式留下的存储 mark；$from.marks() = 光标紧邻格式化文本时的位置 mark，
      //   两者任一存在都会让新输入的字符继承格式并合并进同一个 <strong> 等标签）
      handleTextInput: (view, from, to, text) => {
        if (text === " ") {
          const { state } = view;
          const stored = state.storedMarks ?? [];
          const active = state.selection.$from.marks();
          const marks = [...new Set([...stored, ...active])];
          if (marks.length > 0) {
            const tr = state.tr.insertText(" ", from, to);
            for (const m of marks) {
              tr.removeMark(from, from + 1, m);
              tr.removeStoredMark(m);
            }
            view.dispatch(tr.scrollIntoView());
            return true;
          }
        }
        return false;
      },
      handlePaste: (view, event) => {
        // 有富文本 HTML 时交给默认处理；纯文本按 Markdown 解析转块
        const html = event.clipboardData?.getData("text/html");
        if (html && /<[a-z][\s\S]*>/i.test(html)) return false;
        const text = event.clipboardData?.getData("text/plain");
        if (!text) return false;
        try {
          // 无 markdown 结构的纯文本：按行拆段落保留换行；有 markdown 语法才转换
          const json = looksLikeMarkdown(text) ? markdownToJson(text) : textToBlocks(text);
          const nodes = (json.content ?? []).map((b) => PMNode.fromJSON(view.state.schema, b));
          const slice = new Slice(Fragment.fromArray(nodes), 0, 0);
          view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView());
          return true;
        } catch (e) {
          console.error("markdown paste failed, fallback to plain text", e);
          return false;
        }
      },
    },
    onUpdate: () => scheduleSave(),
    // 选区塌缩后清除存储 marks：格式只作用于被选中的文字，不再延续到后续输入
    // （TipTap 的 toggleMark/setMark 会同时设置 storedMarks，导致加粗/高亮后继续输入仍带格式）
    onSelectionUpdate: ({ editor }) => {
      const { selection, storedMarks } = editor.state;
      if (selection.empty && storedMarks && storedMarks.length > 0) {
        editor.view.dispatch(editor.state.tr.setStoredMarks([]));
      }
    },
  });
  editorRef.current = editor;

  // 加载文档内容
  useEffect(() => {
    let alive = true;
    const editor = editorRef.current;
    documentApi
      .get(view.id)
      .then((content) => {
        if (!alive || !editor || editor.isDestroyed) return;
        if (content) {
          try {
            const json = JSON.parse(content) as JSONContent;
            // 用户若已开始输入则不覆盖
            if (editor.isEmpty) {
              editor.commands.setContent(json);
            }
          } catch (e) {
            console.error("parse document content failed", view.id, e);
          }
        }
      })
      .catch((e) => console.error("load document failed", view.id, e));
    return () => {
      alive = false;
    };
  }, [view.id]);

  // 卸载/切页/关闭前 flush；页面隐藏时也 flush
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    const onBeforeUnload = () => flush();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("beforeunload", onBeforeUnload);
      flush();
    };
  }, [flush]);

  // 全局 Ctrl+S（编辑器未聚焦时也保存）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        flush();
        toast.success(t("editor.saved"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flush]);

  // 点击 mention mark 跳转到对应页面（通过 posAtCoords + resolve 读 mark attrs.id，避免修改 renderHTML）
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const host = editor.view.dom as HTMLElement;
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const nodeEl = target.closest<HTMLElement>(".mention");
      if (!nodeEl) return;
      // 通过 ProseMirror 坐标反推 position，再解析 position 的所有 mark 找到 mention
      const rect = nodeEl.getBoundingClientRect();
      const center = {
        left: rect.left + rect.width / 2,
        top:  rect.top  + rect.height / 2,
      };
      const posResult = editor.view.posAtCoords(center);
      if (!posResult) return;
      const pos = posResult.pos;
      const $pos = editor.state.doc.resolve(pos);
      const around = $pos.marks().concat(editor.state.doc.nodeAt(pos)?.marks ?? []);
      // 也尝试 pos-1 / pos+1 附近（点击边界可能 miss）
      let found: string | null = null;
      const candidates = [$pos.marks(), around];
      for (const markList of candidates) {
        const m = markList.find((mk) => mk.type.name === "mention");
        if (m) { found = m.attrs.id as string; break; }
      }
      if (!found) {
        // 回退：在 pos±2 的 span 内扫描 marks
        for (let off = -2; off <= 2 && !found; off++) {
          const p = pos + off;
          if (p < 0 || p > editor.state.doc.content.size) continue;
          const $ = editor.state.doc.resolve(p);
          const m = $.marks().find((mk) => mk.type.name === "mention");
          if (m) found = m.attrs.id as string;
        }
      }
      if (found) {
        e.preventDefault();
        const open = useWorkspaceStore.getState().openView;
        open(found);
      }
    };
    host.addEventListener("click", onClick);
    return () => host.removeEventListener("click", onClick);
  }, [editor?.view]);

  const commitTitle = () => {
    const name = titleDraft.trim();
    setEditingTitle(false);
    if (name && name !== view.name) {
      void renameView(view.id, name);
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-white">
      {/* 顶栏标题行（说明书 6.2：高 44px；行详情弹窗复用正文时可隐藏） */}
      {!hideTitle && (
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-neutral-200 px-6">
        <span className="text-lg leading-none">{viewIcon(view)}</span>
        {editingTitle ? (
          <input
            autoFocus
            className="min-w-0 flex-1 rounded border border-neutral-300 px-1.5 text-[15px] font-medium text-neutral-800 outline-none focus:border-brand-500"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitTitle();
              if (e.key === "Escape") setEditingTitle(false);
            }}
          />
        ) : (
          <h1
            className="min-w-0 flex-1 cursor-text truncate text-[15px] font-medium text-neutral-800"
            onDoubleClick={() => {
              setTitleDraft(view.name);
              setEditingTitle(true);
            }}
          >
            {view.name}
          </h1>
        )}
        <span className="shrink-0 text-[11px] text-neutral-400">{editor?.storage.characterCount.characters?.() ?? 0} chars</span>
      </div>
      )}

      {/* 编辑区：内容最大宽约 800px 居中（说明书 6.1） */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[800px] px-6 py-4">
          <EditorContent editor={editor} />
          <FloatingMenu editor={editor ?? undefined} />
          <TableContextMenu editor={editor} />
        </div>
      </div>
    </div>
  );
}