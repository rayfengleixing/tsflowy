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
import { Link2, ChevronDown, ChevronUp } from "lucide-react";
import { useWorkspaceStore } from "@/stores/workspace";
import { documentApi } from "@/lib/documents";
import { mentionsApi, type MentionRow } from "@/lib/mentions";
import { viewApi } from "@/lib/db";
import { looksLikeMarkdown, markdownToJson, textToBlocks } from "@/lib/markdown";
import { t } from "@/lib/i18n";
import type { View } from "@/types/models";
import { SlashMenu } from "./slash-menu";
import { TableContextMenu } from "./table-context-menu";
import { FloatingMenu } from "./floating-menu";
import { PageProperties } from "./PageProperties";
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
import { FirstHeadingLock } from "./extensions/first-heading-lock";
import { BlockDrag } from "./extensions/block-drag";

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
export function EditorPage({ view, hideSlash = false }: { view: View; hideSlash?: boolean }) {
  const editorRef = useRef<ReturnType<typeof useEditor>>(null);
  const dirtyRef = useRef(false);
  const saveTimer = useRef<number | null>(null);
  const [backlinks, setBacklinks] = useState<MentionRow[]>([]);
  const [backlinkViews, setBacklinkViews] = useState<Map<string, View>>(new Map());
  const [backlinksOpen, setBacklinksOpen] = useState(true);
  // mention hover 预览：当前 hover 的 mention 目标 id + 预览内容（前几行纯文本）
  const [hoverMention, setHoverMention] = useState<{ id: string; rect: DOMRect; text: string } | null>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const hoverCacheRef = useRef<Map<string, string>>(new Map());
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
        HTMLAttributes: {
          class:
            "mention cursor-pointer underline decoration-dotted underline-offset-2 text-brand-600 hover:text-brand-700",
        },
        suggestion: buildMentionSuggestion(),
      }),
      // — M3 高级块结束 —
      ...(hideSlash ? [] : [SlashMenu]),
      FirstHeadingLock.configure({ viewId: view.id }),
      BlockDrag,
    ],

    [hideSlash, view.id],
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
            editorRef.current.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
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
        // 图片粘贴上传：检测 clipboard 中的图片文件
        const items = event.clipboardData?.items;
        if (items) {
          for (const item of items) {
            if (item.type.startsWith("image/")) {
              const file = item.getAsFile();
              if (file) {
                event.preventDefault();
                const reader = new FileReader();
                reader.onload = async () => {
                  const buf = reader.result;
                  if (buf instanceof ArrayBuffer) {
                    const bytes = new Uint8Array(buf);
                    const ext = file.type.split("/")[1] || "png";
                    const filename = `paste-${Date.now()}.${ext}`;
                    try {
                      const { invoke } = await import("@tauri-apps/api/core");
                      const assetPath = await invoke<string>("save_asset_bytes", {
                        bytes: Array.from(bytes),
                        filename,
                      });
                      const node = view.state.schema.nodes.image.create({ src: assetPath });
                      view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView());
                    } catch (e) {
                      toast.error(t("editor.imageUploadFailed"));
                    }
                  }
                };
                reader.readAsArrayBuffer(file);
                return true;
              }
            }
          }
        }
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

  // 反链面板：view.id 变化或文档保存后刷新（mentions 表在 scheduleSave→rebuildFor 时已更新）。
  // 切页时先清空旧数据，避免上一个文档的反链短暂残留。
  useEffect(() => {
    let alive = true;
    setBacklinks([]);
    setBacklinkViews(new Map());
    if (!view.id) return;
    void mentionsApi.listBacklinks(view.id).then(async (rows) => {
      if (!alive) return;
      setBacklinks(rows);
      // 批量取来源视图名（一次一个；反链数量通常 < 20）
      const m = new Map<string, View>();
      for (const r of rows) {
        if (m.has(r.src_view_id)) continue;
        const v = await viewApi.get(r.src_view_id);
        if (v) m.set(r.src_view_id, v);
      }
      if (alive) setBacklinkViews(m);
    });
    return () => {
      alive = false;
    };
  }, [view.id]);

  // mention hover 预览：mouseenter/mouseleave + 300ms 延迟，避免快速划过频繁拉取
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const host = editor.view.dom;

    const resolveMentionId = (target: HTMLElement): string | null => {
      const nodeEl = target.closest<HTMLElement>(".mention");
      if (!nodeEl) return null;
      const rect = nodeEl.getBoundingClientRect();
      const center = { left: rect.left + rect.width / 2, top: rect.top + rect.height / 2 };
      const posResult = editor.view.posAtCoords(center);
      if (!posResult) return null;
      const pos = posResult.pos;
      const $pos = editor.state.doc.resolve(pos);
      let found: string | null = null;
      const m = $pos.marks().find((mk) => mk.type.name === "mention");
      if (m) found = m.attrs.id as string;
      if (!found) {
        for (let off = -2; off <= 2 && !found; off++) {
          const p = pos + off;
          if (p < 0 || p > editor.state.doc.content.size) continue;
          const $ = editor.state.doc.resolve(p);
          const mk = $.marks().find((k) => k.type.name === "mention");
          if (mk) found = mk.attrs.id as string;
        }
      }
      return found;
    };

    const fetchPreview = async (id: string, rect: DOMRect) => {
      const cached = hoverCacheRef.current.get(id);
      if (cached) {
        setHoverMention({ id, rect, text: cached });
        return;
      }
      // 拉文档前几行纯文本作预览（避免渲染富文本，简化实现）
      try {
        const raw = await documentApi.get(id);
        if (!raw) {
          setHoverMention({ id, rect, text: t("mention.previewEmpty") });
          return;
        }
        const json = JSON.parse(raw) as JSONContent;
        const text = extractPlainText(json).slice(0, 200);
        hoverCacheRef.current.set(id, text);
        setHoverMention({ id, rect, text });
      } catch {
        setHoverMention({ id, rect, text: t("mention.previewEmpty") });
      }
    };

    const onMouseMove = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const id = resolveMentionId(target);
      if (id) {
        const nodeEl = target.closest<HTMLElement>(".mention")!;
        const rect = nodeEl.getBoundingClientRect();
        if (hoverTimerRef.current !== null) {
          window.clearTimeout(hoverTimerRef.current);
        }
        hoverTimerRef.current = window.setTimeout(() => fetchPreview(id, rect), 300);
        return;
      }
      if (hoverTimerRef.current !== null) {
        window.clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = null;
      }
      setHoverMention(null);
    };

    host.addEventListener("mousemove", onMouseMove);
    return () => {
      host.removeEventListener("mousemove", onMouseMove);
      if (hoverTimerRef.current !== null) {
        window.clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = null;
      }
    };
  }, [editor?.view]);

  // 点击 mention mark 跳转到对应页面（通过 posAtCoords + resolve 读 mark attrs.id，避免修改 renderHTML）
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const host = editor.view.dom;
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const nodeEl = target.closest<HTMLElement>(".mention");
      if (!nodeEl) return;
      // 通过 ProseMirror 坐标反推 position，再解析 position 的所有 mark 找到 mention
      const rect = nodeEl.getBoundingClientRect();
      const center = {
        left: rect.left + rect.width / 2,
        top: rect.top + rect.height / 2,
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
        if (m) {
          found = m.attrs.id as string;
          break;
        }
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

  // 反链按来源分组：src_view_id → MentionRow[]
  const groupedBacklinks = useMemo(() => {
    const m = new Map<string, MentionRow[]>();
    for (const r of backlinks) {
      const arr = m.get(r.src_view_id) ?? [];
      arr.push(r);
      m.set(r.src_view_id, arr);
    }
    return m;
  }, [backlinks]);

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-white">
      {/* 页面属性：标题下方横排 chip，不占太多高度 */}
      <PageProperties view={view} />

      {/* 编辑区：内容最大宽约 800px 居中（说明书 6.1） */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[800px] px-6 py-4">
          <EditorContent editor={editor} />
          <FloatingMenu editor={editor ?? undefined} />
          <TableContextMenu editor={editor ?? undefined} />
        </div>
      </div>

      {/* 反链面板：底部固定，可收起 */}
      {backlinks.length > 0 && (
        <div className="shrink-0 border-t border-neutral-200 bg-neutral-50/60">
          <button
            type="button"
            onClick={() => setBacklinksOpen((v) => !v)}
            className="flex w-full items-center gap-1.5 px-4 py-1.5 text-left text-[11px] font-semibold text-neutral-600 hover:bg-neutral-100"
          >
            <Link2 className="h-3 w-3" />
            {t("backlinks.title", { n: groupedBacklinks.size })}
            {backlinksOpen ? <ChevronUp className="ml-auto h-3 w-3" /> : <ChevronDown className="ml-auto h-3 w-3" />}
          </button>
          {backlinksOpen && (
            <div className="max-h-[160px] overflow-y-auto px-4 pb-2">
              {Array.from(groupedBacklinks.entries()).map(([srcId, rows]) => {
                const srcView = backlinkViews.get(srcId);
                const name = srcView?.name ?? srcId;
                return (
                  <div key={srcId} className="mb-1.5 last:mb-0">
                    <div className="flex items-center gap-1 text-[11px] text-neutral-500">
                      <button
                        type="button"
                        className="font-medium text-brand-600 hover:underline"
                        onClick={() => useWorkspaceStore.getState().openView(srcId)}
                        title={t("backlinks.openSource")}
                      >
                        {name}
                      </button>
                      <span className="text-neutral-400">· {rows.length}</span>
                    </div>
                    <ul className="ml-2 mt-0.5 space-y-0.5">
                      {rows.slice(0, 3).map((r) => (
                        <li
                          key={r.id}
                          className="cursor-pointer rounded px-1.5 py-0.5 text-[12px] text-neutral-600 hover:bg-neutral-100"
                          onClick={() => useWorkspaceStore.getState().openView(srcId)}
                          title={t("backlinks.contextLabel")}
                        >
                          {r.context_text ?? ""}
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* 字数统计：右下角浮层 */}
      {editor && (
        <div className="pointer-events-none absolute bottom-2 right-4 text-[11px] text-neutral-400">
          {editor.storage.characterCount?.characters?.() ?? 0} {t("editor.chars")}
        </div>
      )}

      {/* mention hover 预览浮层：定位到 mention 节点下方 */}
      {hoverMention && (
        <div
          className="pointer-events-none absolute z-50 max-w-[320px] rounded-md border border-neutral-200 bg-white p-2 text-[12px] text-neutral-700 shadow-lg"
          style={{
            left: globalThis.Math.min(hoverMention.rect.left, window.innerWidth - 340),
            top: hoverMention.rect.bottom + 4,
          }}
        >
          <div className="mb-1 truncate text-[11px] font-medium text-brand-600">
            {backlinkViews.get(hoverMention.id)?.name ?? hoverMention.id}
          </div>
          <div className="max-h-[120px] overflow-y-auto whitespace-pre-wrap break-words text-neutral-600">
            {hoverMention.text}
          </div>
        </div>
      )}
    </div>
  );
}

/** 递归提取 TipTap JSON 的纯文本（用于 mention hover 预览 / 反链 context 兜底） */
function extractPlainText(node: JSONContent): string {
  if (typeof node.text === "string") return node.text;
  if (!node.content) return "";
  return node.content.map(extractPlainText).join("");
}
