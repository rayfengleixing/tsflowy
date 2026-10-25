import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import Highlight from "@tiptap/extension-highlight";
import TextAlign from "@tiptap/extension-text-align";
import { TextStyle } from "@tiptap/extension-text-style";
import Color from "@tiptap/extension-color";
import { countWords, readingMinutes } from "@/lib/word-count";
import TaskList from "@tiptap/extension-task-list";
// 任务行带「截止日期 / 负责人」两个自定义 attrs，chip 靠渲染属性显形（见 extensions/task-meta.ts）
import { TaskItemWithMeta } from "./extensions/task-meta";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { createNodeFromContent, type JSONContent } from "@tiptap/core";
import { Slice, Fragment, Node as PMNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { toast } from "sonner";
import { Link2, ChevronDown, ChevronUp } from "lucide-react";
import { useWorkspaceStore } from "@/stores/workspace";
import { registerDocEditor, useEditorStore } from "@/stores/editor";
import { useSettingsStore } from "@/stores/settings";
import { documentApi } from "@/lib/documents";
import { mentionsApi, type MentionRow } from "@/lib/mentions";
import { looksLikeMarkdown, markdownToJson, textToBlocks } from "@/lib/markdown";
import { pickImageExt, uploadImageBytes } from "@/lib/assets";
import { registerCloseFlush } from "@/lib/close-flush";
import { readCaret, writeCaret, type CaretMark } from "@/lib/caret-memory";
import { captureCaretMark, resolveCaretPos, CARET_LINE_RATIO, TYPEWRITER_RATIO } from "./caret-position";
import { registerAiEditor, registerAiEditorForView, type AiEditorBridge } from "@/lib/ai-editor";
import { onEscapeClose } from "@/lib/escape-close";
import { t } from "@/lib/i18n";
import {
  useShortcutsStore,
  comboEquals,
  eventToCombo,
  BUILTIN_EDITOR_KEYS,
  EDITOR_SHORTCUT_IDS,
  DEFAULT_SHORTCUTS,
  type ShortcutId,
} from "@/lib/shortcuts";
import { flattenTree } from "@/lib/tree";
import { logger } from "@/lib/logger";
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
import { Mermaid } from "./extensions/mermaid/node";
import { Callout } from "./extensions/callout/node";
import { Toggle } from "./extensions/toggle/node";
import { Outline } from "./extensions/outline/node";
import { Subpages } from "./extensions/subpages/node";
import { Columns, Column } from "./extensions/columns/node";
import { ImageGallery } from "./extensions/image-gallery/node";
import { LiveMention } from "./extensions/mention/node";
import { buildMentionSuggestion } from "./extensions/mention/suggestion";
// — M3 高级块结束 —
import "highlight.js/styles/github.css";
import { FirstHeadingLock } from "./extensions/first-heading-lock";
import { BlockDrag } from "./extensions/block-drag";
import { LockedHeading, DocumentStructureLock, STRUCTURE_SYNC_META } from "./extensions/document-structure-lock";
import { clearFind, FindReplace } from "./extensions/find-replace";
import { FindReplaceBar } from "./FindReplaceBar";
import { AUTOSAVE_MS, reportSaveMetrics } from "./doc-save";
import { CenteredTableCell, CenteredTableHeader } from "./table-centered";

// Markdown 符号输入规则由内置扩展自带：**粗体** / *斜体* / ==高亮== / ~~删除线~~ / `代码`
// （@tiptap/extension-bold·italic·strike·highlight·code 的 addInputRules 已注册，无需自定义）

/** 全局快捷键的归属判断（分栏修复）：焦点在某栏内则只归该栏；焦点不在任何栏时主栏兜底 */
function ownsPaneShortcuts(paneEl: HTMLElement | null, isMainPane: boolean): boolean {
  const focusedPane = document.querySelector("[data-editor-pane]:focus-within");
  if (focusedPane) return focusedPane === paneEl;
  return isMainPane;
}

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
  // 编辑区滚动容器（隐藏滚动条 + 光标行 70% 规则都挂在它上面）
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // 面板根节点：全局快捷键（Ctrl+S/F）判断焦点归属用（分栏时只让"焦点所在栏"响应）
  const paneRef = useRef<HTMLDivElement | null>(null);
  // 文档内查找替换面板（Ctrl+F）
  const [findOpen, setFindOpen] = useState(false);
  // 上一次选区变化是否来自键盘：鼠标点击不触发上滚，否则点到下半屏会把视图顶飞
  const keyNavRef = useRef(false);
  const caretRafRef = useRef<number | null>(null);
  // 本页最后一次的光标位置（选区变化时更新，离开本页时才落库）
  const caretRef = useRef<Omit<CaretMark, "scrollTop"> | null>(null);
  // 编辑区滚动位置单独记：只滚动不动光标的一段阅读也该被记住
  const scrollTopRef = useRef(0);
  // 正文加载完到恢复光标之间用户已经自己动手点过：那就别抢他的位置和焦点
  const interactedRef = useRef(false);
  // 正文加载完成（编辑器交接给只读模式）前为 false：见加载竞态注释
  const docLoadedRef = useRef(false);
  const editorReadonly = useSettingsStore((s) => s.editorReadonly);
  const focusMode = useSettingsStore((s) => s.focusMode);
  const typewriter = useSettingsStore((s) => s.typewriter);

  // 返回落库 promise：关窗冲刷（close-flush）需要 await 真正写完；平时调用方忽略即可。
  // 成功才清脏标记：失败时保留，下一次 flush（含关窗前的冲刷）可以重试同一份内容。
  const flush = useCallback((): Promise<void> => {
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    // 用缓存的最新 JSON 落库：卸载时 editor 可能已被销毁，不能依赖 editor 实例
    if (!dirtyRef.current || !latestJsonRef.current) return Promise.resolve();
    const json = latestJsonRef.current;
    const payload = JSON.stringify(json);
    const startedAt = performance.now();
    return documentApi.save(view.id, payload).then(
      () => {
        reportSaveMetrics(view.id, payload.length, performance.now() - startedAt);
        // 期间若有更新内容进 latestJsonRef，不能误清（下一轮 flush 会带上它）
        if (latestJsonRef.current === json) {
          latestJsonRef.current = null;
          dirtyRef.current = false;
        }
      },
      (e: unknown) => {
        logger.error("autosave failed", view.id, e);
        toast.error(t("error.saveDoc", { message: String(e) }));
        throw e;
      },
    );
  }, [view.id]);

  /** 非关窗路径的落库调用（卸载/隐藏/防抖）：失败已 toast，吞掉 rejection 防止 unhandled */
  const flushQuietly = useCallback(() => {
    void flush().catch(() => undefined);
  }, [flush]);

  const scheduleSave = useCallback(() => {
    const editor = editorRef.current;
    if (!editor || editor.isDestroyed) return;
    latestJsonRef.current = editor.getJSON();
    dirtyRef.current = true;
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(flushQuietly, AUTOSAVE_MS);
  }, [flushQuietly]);

  // 光标行位置：打字机模式钉死在中线（上下都调），否则只把超过 70% 线的行推上来。
  // rAF 里量（等浏览器的原生光标滚动先落地，否则会被它覆盖回去）
  const clampCaretSoon = useCallback(() => {
    if (caretRafRef.current !== null) return;
    caretRafRef.current = window.requestAnimationFrame(() => {
      caretRafRef.current = null;
      const ed = editorRef.current;
      const scroller = scrollRef.current;
      if (!ed || ed.isDestroyed || !scroller) return;
      const box = scroller.getBoundingClientRect();
      const caret = ed.view.coordsAtPos(ed.state.selection.head);
      // 模式开关走 getState：这个回调喂给 useEditor（只建一次），订阅值会停留在首帧
      if (useSettingsStore.getState().typewriter) {
        scroller.scrollTop += caret.bottom - (box.top + box.height * TYPEWRITER_RATIO);
        return;
      }
      const overflow = caret.bottom - (box.top + box.height * CARET_LINE_RATIO);
      if (overflow > 1) scroller.scrollTop += overflow;
    });
  }, []);

  // 单文档编辑互斥：只有当前标签页挂载编辑器，切换/关闭即卸载并 flush
  // extensions 数组需稳定引用（useEditor 按引用比较），否则每次渲染都会 setOptions
  const extensions = useMemo(
    () => [
      StarterKit.configure({
        link: { openOnClick: false, autolink: true },
        codeBlock: false,
        heading: false,
      }),
      // 标题：H1 锁定为只读文档标题（首行），H2–H6 正常可编辑
      LockedHeading.configure({ levels: [1, 2, 3, 4, 5, 6] }),
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
      TaskList,
      TaskItemWithMeta.configure({ nested: true }),
      Table.configure({ resizable: true }),
      TableRow,
      CenteredTableHeader,
      CenteredTableCell,
      Image,
      DatabaseView,
      Attachment,
      // — M3 高级块（注册顺序不敏感，mention 是 mark，其余是 node）—
      Math,
      Mermaid,
      Callout,
      Toggle,
      Outline,
      Columns,
      Column,
      ImageGallery,
      LiveMention.configure({
        HTMLAttributes: {
          class:
            "mention cursor-pointer underline decoration-dotted underline-offset-2 text-brand-600 hover:text-brand-700",
        },
        suggestion: buildMentionSuggestion(),
      }),
      // — M3 高级块结束 —
      ...(hideSlash ? [] : [SlashMenu]),
      FirstHeadingLock.configure({ viewId: view.id }),
      Subpages.configure({ viewId: view.id }),
      BlockDrag,
      FindReplace,
    ],

    [hideSlash, view.id],
  );

  // 可自定义编辑器命令的实际执行（B9）。与 Ctrl+T/Ctrl+L 一致走 editorRef，
  // 避免在 useEditor 参数里引用尚未创建的 editor 实例。
  const runEditorShortcut = (id: ShortcutId) => {
    const ed = editorRef.current;
    if (!ed || ed.isDestroyed) return;
    switch (id) {
      case "bold":
        ed.chain().focus().toggleBold().run();
        break;
      case "italic":
        ed.chain().focus().toggleItalic().run();
        break;
      case "underline":
        ed.chain().focus().toggleUnderline().run();
        break;
      case "strike":
        ed.chain().focus().toggleStrike().run();
        break;
      case "undo":
        ed.chain().focus().undo().run();
        break;
      case "redo":
        ed.chain().focus().redo().run();
        break;
    }
  };

  const editor = useEditor({
    extensions,
    content: { type: "doc", content: [] },
    // 初次挂载只读：文档加载完成（或失败）前禁止输入，防止「加载期间输入 → 加载内容被丢弃
    // → 自动保存用残缺内容覆盖整篇文档」的竞态（解锁见下方 load effect）
    editable: false,
    editorProps: {
      attributes: { class: "tiptap focus:outline-none" },
      // 鼠标点击落光标不算"导航"：置位后仅键盘触发上滚（见 clampCaretSoon）
      handleDOMEvents: {
        mousedown: () => {
          keyNavRef.current = false;
          interactedRef.current = true;
          return false;
        },
      },
      handleKeyDown: (_view, event) => {
        keyNavRef.current = true;
        interactedRef.current = true;
        const metaOrCtrl = event.ctrlKey || event.metaKey;
        // 硬编码的编辑器命令一律不吞带 Alt 的组合：Alt 档留给全局快捷键（AltGr 布局因此也不会误触发）
        const plainMod = metaOrCtrl && !event.altKey;
        // — 文档内查找替换：Ctrl+F 打开面板（面板内 Enter/Shift+Enter 走各自输入框）—
        if (plainMod && !event.shiftKey && event.key.toLowerCase() === "f") {
          event.preventDefault();
          setFindOpen(true);
          return true;
        }
        // — 快捷键 1：Ctrl+S 手动保存（Ctrl+Shift+S 留给「删除线」） —
        if (plainMod && !event.shiftKey && event.key.toLowerCase() === "s") {
          event.preventDefault();
          flush()
            .then(() => toast.success(t("editor.saved")))
            .catch(() => undefined);
          return true;
        }
        // — M6 修复 5：Ctrl+T 插入 3×3 表格（带表头）—
        if (plainMod && event.key.toLowerCase() === "t") {
          event.preventDefault();
          if (editorRef.current && !editorRef.current.isDestroyed) {
            editorRef.current.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
          }
          return true;
        }
        // — M6 修复 5：Ctrl+L 切换任务列表（段落↔任务项）—
        if (plainMod && event.key.toLowerCase() === "l") {
          event.preventDefault();
          if (editorRef.current && !editorRef.current.isDestroyed) {
            editorRef.current.chain().focus().toggleTaskList().run();
          }
          return true;
        }
        // — 可自定义编辑器命令（B9）：加粗/斜体/下划线/删除线/撤销/重做 —
        // handleKeyDown 先于各扩展内置 keymap 执行：命中当前绑定就执行命令；
        // 命中扩展内置默认键但已被用户改绑到别处，则吞掉（返回 true 不执行），
        // 保证"改绑后旧默认键失效"。
        const edCombo = eventToCombo(event);
        if (edCombo) {
          const { combos } = useShortcutsStore.getState();
          const hit = EDITOR_SHORTCUT_IDS.find((id) => comboEquals(combos[id], edCombo));
          if (hit) {
            event.preventDefault();
            runEditorShortcut(hit);
            return true;
          }
          // 内置默认键：仅当用户把该命令改绑到别处时才吞掉（返回 true 不执行），
          // 未改绑时放行给 TipTap 内置 keymap（保留 Ctrl+Y 重做等别名）。
          const builtin = BUILTIN_EDITOR_KEYS.find((b) => comboEquals(b.combo, edCombo));
          if (builtin && !comboEquals(combos[builtin.id], DEFAULT_SHORTCUTS[builtin.id])) {
            event.preventDefault();
            return true;
          }
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
                    try {
                      const assetPath = await uploadImageBytes(new Uint8Array(buf), pickImageExt(file));
                      // 异步期间选区/文档可能已变：用当前 editor 状态构造事务，
                      // 不能再用闭包捕获的 view.state（会触发 ProseMirror mismatched transaction）
                      const ed = editorRef.current;
                      if (!ed || ed.isDestroyed) return;
                      const node = ed.state.schema.nodes.image.create({ src: assetPath });
                      ed.view.dispatch(ed.state.tr.replaceSelectionWith(node).scrollIntoView());
                    } catch (e) {
                      logger.error("paste image failed", e);
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
        // 粘贴源分三类：
        // 1) 纯文本含 markdown 结构（列表/标题/围栏…）→ 走 markdown 转换
        // 2) 富文本 HTML 有真实结构（ul/ol/table/标题/图片…）→ 交给默认 HTML 解析
        // 3) 富文本只是"段落化"的 markdown 源码（AI 聊天工具常见：text/html 是 <p>- a</p>，
        //    text/plain 才是原始 markdown）→ 走 markdown 转换，否则 "- item" 变普通段落
        const html = event.clipboardData?.getData("text/html");
        const text = event.clipboardData?.getData("text/plain");
        if (text && looksLikeMarkdown(text)) {
          const htmlHasStructure = !!html && /<(ul|ol|table|h[1-6]|pre|blockquote|img)\b/i.test(html);
          if (!htmlHasStructure) {
            try {
              const json = markdownToJson(text);
              const nodes = (json.content ?? []).map((b) => PMNode.fromJSON(view.state.schema, b));
              const slice = new Slice(Fragment.fromArray(nodes), 0, 0);
              view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView());
              return true;
            } catch (e) {
              logger.error("markdown paste failed, fallback to default", e);
            }
          }
          return false;
        }
        if (html && /<[a-z][\s\S]*>/i.test(html)) return false;
        if (!text) return false;
        try {
          // 无 markdown 结构的纯文本：按行拆段落保留换行
          const json = textToBlocks(text);
          const nodes = (json.content ?? []).map((b) => PMNode.fromJSON(view.state.schema, b));
          const slice = new Slice(Fragment.fromArray(nodes), 0, 0);
          view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView());
          return true;
        } catch (e) {
          logger.error("plain text paste failed, fallback to default", e);
          return false;
        }
      },
    },
    onUpdate: () => {
      scheduleSave();
      clampCaretSoon();
    },
    // 选区塌缩后清除存储 marks：格式只作用于被选中的文字，不再延续到后续输入
    // （TipTap 的 toggleMark/setMark 会同时设置 storedMarks，导致加粗/高亮后继续输入仍带格式）
    onSelectionUpdate: ({ editor }) => {
      const { selection, storedMarks } = editor.state;
      if (selection.empty && storedMarks && storedMarks.length > 0) {
        editor.view.dispatch(editor.state.tr.setStoredMarks([]));
      }
      if (keyNavRef.current) clampCaretSoon();
      // 记一下光标落在哪：正文加载完成前不记（setContent 的那次选区更新不是用户位置）
      if (docLoadedRef.current) {
        const mark = captureCaretMark(editor.state.doc, selection.head);
        if (mark) caretRef.current = mark;
      }
    },
  });
  editorRef.current = editor;

  // 推送 editor 到全局 store：侧边栏大纲（DocumentOutline）与导出都从这里读取；
  // 卸载/切换视图时清空，避免大纲读到已销毁实例。
  // 并排对照时两栏各有一个编辑器，只让主视图（currentViewId）这一栏推送，
  // 避免副栏抢占大纲与导出目标。
  const isMainPane = useWorkspaceStore((s) => s.currentViewId === view.id);
  useEffect(() => {
    if (!isMainPane) return;
    useEditorStore.getState().setEditor(editor, view.id);
    return () => {
      useEditorStore.getState().setEditor(null, null);
    };
  }, [editor, view.id, isMainPane]);

  // 登记到文档编辑器注册表（主栏与分栏副栏都登记）：子页面块等"就地更新打开中的文档"
  // 的逻辑需要覆盖每一个实例，否则副栏跟进自动保存时会把就地更新覆盖回旧内容
  useEffect(() => {
    if (editor.isDestroyed) return;
    return registerDocEditor(view.id, editor);
  }, [editor, view.id]);

  // ——— 光标与滚动位置记忆（离开本页时写，下次打开回到原处）———
  // 记的是「顶层第几块 + 块内第几个字」而不是绝对 pos：pos 会被别处的增删整体带偏。
  const persistCaret = useCallback((): Promise<void> => {
    const mark = caretRef.current;
    const wsId = useWorkspaceStore.getState().currentWorkspaceId;
    if (!mark || !wsId) return Promise.resolve();
    return writeCaret(wsId, view.id, { block: mark.block, offset: mark.offset, scrollTop: scrollTopRef.current });
  }, [view.id]);

  const restoreCaret = useCallback(async () => {
    const wsId = useWorkspaceStore.getState().currentWorkspaceId;
    if (!wsId) return;
    const mark = await readCaret(wsId, view.id);
    if (!mark) return;
    const ed = editorRef.current;
    // await 期间用户可能已经点开了别处：光标位置和焦点都归他，不抢
    if (!ed || ed.isDestroyed || interactedRef.current) return;
    const pos = resolveCaretPos(ed.state.doc, mark);
    if (pos === null) return;
    const moved = mark.block > 0 || mark.offset > 0;
    // near：文档变过时这个位置未必还落在正文里，就近找个文本位置，别让它抛
    const sel = TextSelection.near(ed.state.doc.resolve(pos));
    ed.view.dispatch(ed.state.tr.setSelection(sel));
    // 只有「确实回到了文档中部」才接管焦点：主栏、可编辑时才聚焦，
    // 其余情况（副栏、只读、从搜索/链接跳进来）只把选区摆好，不动焦点
    if (moved && ed.isEditable && useWorkspaceStore.getState().currentViewId === view.id) {
      ed.commands.focus(null, { scrollIntoView: false });
    }
    if (mark.scrollTop <= 0) return;
    // 等原生滚动落定后一帧再摆：记忆里的滚动位置才是用户上次看到的地方
    window.requestAnimationFrame(() => {
      const scroller = scrollRef.current;
      if (scroller) scroller.scrollTop = mark.scrollTop;
    });
  }, [view.id]);

  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === "hidden") void persistCaret();
    };
    document.addEventListener("visibilitychange", onHidden);
    // 关窗走 App 的 onCloseRequested 统一冲刷：卸载清理里的异步 IPC 那时已经来不及
    const offClose = registerCloseFlush(persistCaret);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      offClose();
      void persistCaret();
    };
  }, [persistCaret]);

  // AI 助手桥接：供 AI 面板取当前页/选区文本、回填内容。光标/选区类目标
  // （registerAiEditor）只认主栏，与 useEditorStore 推送 editor 的约定一致；
  // 按 viewId 的登记主副栏都要有，故此处不能按 isMainPane 提前 return。
  useEffect(() => {
    if (editor.isDestroyed) return;
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
      getPageText: () =>
        editor.isDestroyed ? "" : editor.state.doc.textBetween(0, editor.state.doc.content.size, "\n"),
      getPageTitle: () => (editor.isDestroyed ? "" : view.name),
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
    // 光标/选区类回填只认主栏；按 viewId 的登记主副栏都要有——
    // 否则 AI 修改副栏打开的页面只能走 JSON 直写库，会被副栏自动保存覆盖回去
    const offCurrent = isMainPane ? registerAiEditor(bridge) : () => undefined;
    const offView = registerAiEditorForView(view.id, bridge);
    return () => {
      offCurrent();
      offView();
    };
  }, [editor, isMainPane, view.id, view.name]);

  // 全库视图 id → View：mention hover 预览取标题走这张表。
  // mention 目标是任意被引页、不一定是反链来源，查 backlinkViews 会大面积落空显示成 id。
  const tree = useWorkspaceStore((s) => s.tree);
  const viewsById = useMemo(() => {
    const m = new Map<string, View>();
    for (const v of flattenTree(tree)) m.set(v.id, v);
    return m;
  }, [tree]);

  // 外部重命名（侧边栏/数据库视图）→ 同步首行 H1 标题：
  // 标题被结构锁定后名称的权威源是 view.name，名称变更时反向写回文档并落库。
  // 挂载时文档还没加载（doc 为空）会早退，所以加载完成后（load effect 的 finally）也要补跑一次，
  // 否则"关闭时改名、再打开文档"的场景首行仍是旧标题，首次输入会把名称回退成旧值。
  const syncH1ToViewName = useCallback(() => {
    const editor = editorRef.current;
    if (!editor || editor.isDestroyed) return;
    const doc = editor.state.doc;
    const first = doc.childCount > 0 ? doc.child(0) : null;
    if (first?.type.name !== "heading" || (first.attrs as { level: number }).level !== 1) return;
    if (first.textContent === view.name) return;
    const tr = editor.state.tr.replaceWith(1, first.nodeSize - 1, editor.state.schema.text(view.name));
    tr.setMeta(STRUCTURE_SYNC_META, true);
    editor.view.dispatch(tr);
  }, [view.name]);
  const syncH1ToViewNameRef = useRef(syncH1ToViewName);
  useEffect(() => {
    syncH1ToViewNameRef.current = syncH1ToViewName;
  }, [syncH1ToViewName]);

  // 加载文档内容：加载完成（或失败）前编辑器保持只读；输入在解锁前无法发生，
  // 从根上消除加载与输入的竞态。
  // 依赖只认 view.id：syncH1ToViewName 随 view.name 变化，放进依赖会让每次改名
  // 都重新拉取整文档（全量 IPC + "editor not empty" 告警刷屏）。
  useEffect(() => {
    let alive = true;
    const editor = editorRef.current;
    const unlock = () => {
      // setEditable 第二参 false：解锁不产生 update 事件
      if (alive && editor && !editor.isDestroyed) {
        docLoadedRef.current = true;
        // 只读模式开着时保持锁定；开关本身的接管见下面那条 effect
        editor.setEditable(!useSettingsStore.getState().editorReadonly, false);
        // 加载完成后补一次 H1 同步（挂载时的 effect 早退且不会因加载再触发）
        syncH1ToViewNameRef.current();
        void restoreCaret();
      }
    };
    documentApi
      .get(view.id)
      .then((content) => {
        if (!alive || !editor || editor.isDestroyed) return;
        if (!content) {
          unlock();
          return;
        }
        let json: JSONContent;
        try {
          json = JSON.parse(content) as JSONContent;
        } catch (e: unknown) {
          logger.error("parse document content failed", view.id, e);
          toast.error(t("error.db", { message: String(e) }));
          // 内容坏掉时保持只读，绝不能留下可编辑的空文档——一次输入就会把空档落库覆盖原文
          return;
        }
        if (!editor.isEmpty) {
          // 只读期间输入不可能到达，理论上不可达；一旦发生宁可告警也不覆盖
          logger.error("document load skipped: editor not empty", view.id);
          return;
        }
        // emitUpdate=false：加载不算修改，避免打开页面就触发一轮自动保存
        try {
          editor.commands.setContent(json, { emitUpdate: false });
          unlock();
          return;
        } catch (e: unknown) {
          // schema 演进兼容：旧文档含当前 schema 不认识的节点时逐块降级，
          // 能装多少装多少——绝不整篇放弃（空文档 + 一次输入 = 覆盖全文）
          logger.warn("document has unknown nodes, loading block-by-block", view.id, e);
          const kept: JSONContent[] = [];
          const children = Array.isArray(json.content) ? json.content : [];
          for (const child of children) {
            try {
              // insertContentAt 命令无法抑制 update 事件，改为直发 preventUpdate 事务：
              // 逐块加载同样不算用户修改
              const node = createNodeFromContent(child, editor.schema, { errorOnInvalidContent: true });
              editor.view.dispatch(
                editor.state.tr.insert(editor.state.doc.content.size, node).setMeta("preventUpdate", true),
              );
              kept.push(child);
            } catch {
              /* 单块装不进就跳过 */
            }
          }
          if (kept.length < children.length) {
            toast.warning(t("editor.partialLoad", { kept: kept.length, total: children.length }));
          }
        }
        unlock();
      })
      .catch((e: unknown) => {
        logger.error("load document failed", view.id, e);
        toast.error(t("error.db", { message: String(e) }));
        // 读取失败同样保持只读：此时磁盘上是未知内容，写回会覆盖它
      });
    return () => {
      alive = false;
    };
  }, [view.id, restoreCaret]);

  // 只读模式：正文没加载完之前 editable 由加载流程掌管（防「加载期间输入被覆盖」的竞态），
  // 加载完成后才轮到开关接管。第二参 false：翻开关不算一次修改，不该触发自动保存。
  useEffect(() => {
    if (!docLoadedRef.current) return;
    const editor = editorRef.current;
    if (!editor || editor.isDestroyed) return;
    editor.setEditable(!editorReadonly, false);
  }, [editorReadonly]);

  // 编辑区尾部留白 = 视口高度减去光标线（与 CARET_LINE_RATIO / TYPEWRITER_RATIO 配对）：
  // 没有这段余量，文档末尾无内容可滚时，光标行只能停在视口底部，上滚规则失效
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ratio = typewriter ? TYPEWRITER_RATIO : CARET_LINE_RATIO;
    const sync = () => el.style.setProperty("--editor-tail", `${el.clientHeight * (1 - ratio)}px`);
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, [typewriter]);

  useEffect(() => {
    syncH1ToViewName();
  }, [syncH1ToViewName, view.id]);

  // 卸载/切页/关闭前 flush；页面隐藏时也 flush
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushQuietly();
    };
    const onBeforeUnload = () => flushQuietly();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("beforeunload", onBeforeUnload);
      flushQuietly();
    };
  }, [flushQuietly]);

  // 关窗冲刷：Tauri 关窗时 beforeunload 里的异步落库可能被中断，
  // 由 App 的 onCloseRequested 统一 await（见 lib/close-flush.ts）
  useEffect(() => registerCloseFlush(flush), [flush]);

  // 全局 Ctrl+S（编辑器未聚焦时也保存）：成功才提示已保存。
  // 分栏时两栏都会注册 window 监听：只让"焦点所在栏"响应，焦点不在任何栏时主栏兜底；
  // e.defaultPrevented 过滤本栏编辑器局部 handleKeyDown 已处理的事件（避免双重提示）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (!ownsPaneShortcuts(paneRef.current, isMainPane)) return;
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        flush()
          .then(() => toast.success(t("editor.saved")))
          .catch(() => undefined);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flush, isMainPane]);

  // 全局 Ctrl+F（编辑器未聚焦时也能打开查找面板）；Ctrl+Shift+F 是全局搜索，不拦。
  // 归属判断同上：分栏时只有焦点所在栏（或主栏兜底）打开查找条
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (!ownsPaneShortcuts(paneRef.current, isMainPane)) return;
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setFindOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isMainPane]);

  // 全局 Esc（App 广播）：焦点在编辑区时也能关掉查找条，并清掉命中高亮
  useEffect(() => {
    if (!findOpen) return;
    return onEscapeClose(() => {
      const ed = editorRef.current;
      if (ed && !ed.isDestroyed) clearFind(ed);
      setFindOpen(false);
    });
  }, [findOpen]);

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
        const nodeEl = target.closest<HTMLElement>(".mention");
        if (!nodeEl) return;
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
  }, [editor.view]);

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
  }, [editor.view]);

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

  // 右下角字数浮层：整篇 textBetween + 分词只在文档真的变过时重算，
  // hoverMention、反链开合这类纯 UI 重渲染不该拖着扫全文（doc 对象不变时 useMemo 直接命中缓存）
  const docForCount = editor.state.doc;
  const docWords = useMemo(
    () => countWords(docForCount.textBetween(0, docForCount.content.size, " ", " ")),
    [docForCount],
  );
  const docMinutes = readingMinutes(docWords);
  const { from, to, empty } = editor.state.selection;
  const selectionWords = empty ? null : countWords(docForCount.textBetween(from, to, " ", " ")).total;

  return (
    <div ref={paneRef} data-editor-pane className="relative flex h-full flex-col overflow-hidden bg-white">
      {/* 编辑区：内容最大宽由 --tiptap-max-width 控制（默认 800px，设置页可调，说明书 6.1）。
          滚动条由 index.css 按 data-editor-scroll 隐藏 */}
      <div
        ref={scrollRef}
        data-editor-scroll
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(e) => {
          scrollTopRef.current = e.currentTarget.scrollTop;
        }}
      >
        <div className="mx-auto px-6 py-4" style={{ maxWidth: "var(--tiptap-max-width, 800px)" }}>
          <EditorContent editor={editor} aria-label={t("editor.documentAria")} />
          {/* 只读模式收掉三个改结构的浮层入口（拖拽手柄由 block-drag 自己按 isEditable 隐藏） */}
          {!editorReadonly && (
            <>
              <FloatingMenu editor={editor} />
              <TableContextMenu editor={editor} />
              <BlockMenu />
            </>
          )}
          {/* 尾部留白：给"光标行不超过 70%"预留可滚动余量，否则文档末尾时光标只能停在视口底部 */}
          <div style={{ height: "var(--editor-tail, 0px)" }} />
        </div>
      </div>

      {findOpen && <FindReplaceBar editor={editor} onClose={() => setFindOpen(false)} />}

      {/* 反链面板：底部固定，可收起；专注模式下连同外壳一起藏起 */}
      {!focusMode && backlinks.length > 0 && (
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
                          role="button"
                          aria-label={t("backlinks.contextLabel")}
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

      {/* 字数统计：右下角浮层。中文按字、英文按词，混排两边都算（见 src/lib/word-count.ts） */}
      <div className="pointer-events-none absolute bottom-2 right-4 text-[11px] text-neutral-400">
        {editorReadonly && (
          <span className="mr-2 rounded bg-neutral-100 px-1.5 py-0.5 text-neutral-500">
            {t("editor.readonlyBadge")}
          </span>
        )}
        {docWords.total.toLocaleString()} {t("editor.wordsUnit")}
        {docMinutes > 0 && <span className="ml-2">· {t("editor.readingTime", { minutes: docMinutes })}</span>}
        {selectionWords !== null && (
          <span className="ml-2">· {t("editor.selectionWords", { count: selectionWords })}</span>
        )}
      </div>

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
            {viewsById.get(hoverMention.id)?.name ?? hoverMention.id}
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
