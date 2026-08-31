import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import Highlight from "@tiptap/extension-highlight";
import TextAlign from "@tiptap/extension-text-align";
import Color from "@tiptap/extension-color";
import CharacterCount from "@tiptap/extension-character-count";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableCell } from "@tiptap/extension-table-cell";
import type { JSONContent } from "@tiptap/core";
import { Slice, Fragment, Node as PMNode } from "@tiptap/pm/model";
import { toast } from "sonner";
import { viewIcon } from "@/components/view-icon";
import { useWorkspaceStore } from "@/stores/workspace";
import { documentApi } from "@/lib/documents";
import { markdownToJson } from "@/lib/markdown";
import { t } from "@/lib/i18n";
import type { View } from "@/types/models";
import { SlashMenu } from "./slash-menu";
import { FloatingToolbar } from "./floating-menu";
import { Image } from "./extensions/image/node";
import { DatabaseView } from "./extensions/database-view/node";
import { Attachment } from "./extensions/attachment/node";

const AUTOSAVE_MS = 800;

/** 文档编辑器页（项目说明书 8.1：读 content → 编辑 → 防抖 800ms 落库 → 切换/关闭前 flush） */
export function EditorPage({ view, hideTitle = false }: { view: View; hideTitle?: boolean }) {
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
        codeBlock: {},
        heading: { levels: [1, 2, 3] },
      }),
      Placeholder.configure({
        placeholder: ({ node }) =>
          node.type.name === "heading" ? t("editor.placeholderHeading") : t("editor.placeholder"),
        emptyEditorClass: "is-editor-empty",
        emptyNodeClass: "is-empty",
      }),
      Highlight.configure({ multicolor: false }),
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      Color,
      CharacterCount,
      TaskList,
      TaskItem.configure({ nested: true }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      Image,
      DatabaseView,
      Attachment,
      SlashMenu,
    ],
    [],
  );

  const editor = useEditor({
    extensions,
    content: { type: "doc", content: [] },
    editorProps: {
      attributes: { class: "tiptap focus:outline-none" },
      handleKeyDown: (_view, event) => {
        // Ctrl+S 手动保存
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          flush();
          toast.success(t("editor.saved"));
          return true;
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
          const json = markdownToJson(text);
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
        </div>
      </div>
      {editor && <FloatingToolbar editor={editor} />}
    </div>
  );
}