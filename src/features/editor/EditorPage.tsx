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
import { useEditorStore } from "@/stores/editor";
import { documentApi } from "@/lib/documents";
import { mentionsApi, type MentionRow } from "@/lib/mentions";
import { looksLikeMarkdown, markdownToJson, textToBlocks } from "@/lib/markdown";
import { registerCloseFlush } from "@/lib/close-flush";
import { t } from "@/lib/i18n";
import type { View } from "@/types/models";
import { SlashMenu } from "./slash-menu";
import { TableContextMenu } from "./table-context-menu";
import { FloatingMenu } from "./floating-menu";
import { BlockMenu } from "./block-menu";
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
import { LockedHeading, DocumentStructureLock, STRUCTURE_SYNC_META } from "./extensions/document-structure-lock";

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

  // 返回落库 promise：关窗冲刷（close-flush）需要 await 真正写完；平时调用方忽略即可
  const flush = useCallback((): Promise<void> => {
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    // 用缓存的最新 JSON 落库：卸载时 editor 可能已被销毁，不能依赖 editor 实例
    if (!dirtyRef.current || !latestJsonRef.current) return Promise.resolve();
    dirtyRef.current = false;
    const json = latestJsonRef.current;
    latestJsonRef.current = null;
    return documentApi.save(view.id, JSON.stringify(json)).catch((e) => {
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
        heading: false,
      }),
      // 标题：H1 锁定为只读文档标题（首行），H2/H3 正常可编辑
      LockedHeading.configure({ levels: [1, 2, 3] }),
      // 结构锁定：首行 H1 + 第二行分割线不可修改（filterTransaction 拦截）
      DocumentStructureLock,
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
    // 初次挂载只读：文档加载完成（或失败）前禁止输入，防止「加载期间输入 → 加载内容被丢弃
    // → 自动保存用残缺内容覆盖整篇文档」的竞态（解锁见下方 load effect）
    editable: false,
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

  // 推送 editor 到全局 store：侧边栏大纲（DocumentOutline）通过 useEditorStore 读取；
  // 卸载/切换视图时清空，避免大纲读到已销毁实例
  useEffect(() => {
    if (!editor) return;
    useEditorStore.getState().setEditor(editor, view.id);
    return () => {
      useEditorStore.getState().setEditor(null, null);
    };
  }, [editor, view.id]);

  // 加载文档内容：加载完成（或失败）前编辑器保持只读；输入在解锁前无法发生，
  // 从根上消除加载与输入的竞态。失败也解锁，不让用户被锁死在空文档上。
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
            if (editor.isEmpty) {
              // emitUpdate=false：加载不算修改，避免打开页面就触发一轮自动保存
              editor.commands.setContent(json, { emitUpdate: false });
            } else {
              // 只读期间输入不可能到达，理论上不可达；一旦发生宁可告警也不覆盖
              console.error("document load skipped: editor not empty", view.id);
            }
          } catch (e: unknown) {
            console.error("parse document content failed", view.id, e);
            toast.error(t("error.db", { message: String(e) }));
          }
        }
      })
      .catch((e: unknown) => {
        console.error("load document failed", view.id, e);
        toast.error(t("error.db", { message: String(e) }));
      })
      .finally(() => {
        // setEditable 第二参 false：解锁不产生 update 事件
        if (alive && editor && !editor.isDestroyed) editor.setEditable(true, false);
      });
    return () => {
      alive = false;
    };
  }, [view.id]);

  // 外部重命名（侧边栏/数据库视图）→ 同步首行 H1 标题：
  // 标题被结构锁定后不可在编辑器内修改，名称变更只能来自外部，反向写回文档并落库
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || editor.isDestroyed) return;
    const doc = editor.state.doc;
    const first = doc.childCount > 0 ? doc.child(0) : null;
    if (!first || first.type.name !== "heading" || (first.attrs as { level: number }).level !== 1) return;
    if (first.textContent === view.name) return;
    const tr = editor.state.tr.replaceWith(1, first.nodeSize - 1, editor.state.schema.text(view.name));
    tr.setMeta(STRUCTURE_SYNC_META, true);
    editor.view.dispatch(tr);
  }, [view.name, view.id]);

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

  // 关窗冲刷：Tauri 关窗时 beforeunload 里的异步落库可能被中断，
  // 由 App 的 onCloseRequested 统一 await（见 lib/close-flush.ts）
  useEffect(() => registerCloseFlush(flush), [flush]);

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
    // listBacklinks 的 JOIN 已带出来源视图完整行，无需再逐条 viewApi.get
    void mentionsApi.listBacklinks(view.id).then((rows) => {
      if (!alive) return;
      setBacklinks(rows);
      const m = new Map<string, View>();
      for (const r of rows) {
        if (!m.has(r.src_view_id)) m.set(r.src_view_id, r.src_view);
      }
      setBacklinkViews(m);
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

    // mention 是 inline atom node（非 mark），DOM 上就是带 data-id 的 span——
    // 直接从节点自身读 id，不做 posAtCoords/marks 反推（那条路对 node 永远找不到）
    const resolveMentionId = (target: HTMLElement): string | null => {
      const nodeEl = target.closest<HTMLElement>(".mention");
      return nodeEl?.getAttribute("data-id") ?? null;
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

  // 点击 mention 跳转到对应页面（双链跳转）：mention 节点 DOM 自带 data-id，直接取用
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const host = editor.view.dom;
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const nodeEl = target.closest<HTMLElement>(".mention");
      const id = nodeEl?.getAttribute("data-id");
      if (!id) return;
      e.preventDefault();
      useWorkspaceStore.getState().openView(id);
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
      {/* 编辑区：内容最大宽由 --tiptap-max-width 控制（默认 800px，设置页可调，说明书 6.1） */}
      <div data-editor-scroll className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto px-6 py-4" style={{ maxWidth: "var(--tiptap-max-width, 800px)" }}>
          <EditorContent editor={editor} />
          <FloatingMenu editor={editor ?? undefined} />
          <TableContextMenu editor={editor ?? undefined} />
          <BlockMenu />
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
