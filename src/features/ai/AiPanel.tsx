import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  Copy,
  Eraser,
  FileText,
  History,
  ImagePlus,
  Languages,
  Lightbulb,
  MessageSquarePlus,
  PenLine,
  Search,
  Send,
  Settings,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { viewIcon } from "@/components/view-icon";
import { useAiStore, visibleSessionWindow, type AiActionRecord, type AiMessage } from "@/stores/ai";
import { useWorkspaceStore } from "@/stores/workspace";
import {
  aiErrorText,
  estimateAiCost,
  formatAiCost,
  MAX_AI_IMAGES,
  saveAiImageFile,
  type AiImageAttachment,
} from "@/lib/ai";
import { filesFromDataTransfer } from "@/lib/assets";
import { getAiEditor } from "@/lib/ai-editor";
import { bestMentionScore, detectMentionQuery } from "@/lib/ai-mention";
import { flattenTree } from "@/lib/tree";
import { parseViewAliases } from "@/types/models";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { EditDiffDialog } from "./EditDiffDialog";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { type BubbleApi, MessageBubble } from "./MessageBubble";
import { ImageThumb, QuickButton, RowAction } from "./AiParts";
import { AI_ERROR_HINT, AI_IMAGE_ACCEPT, filterHistorySessions, safeHost } from "./ai-utils";
/** AI 助手右侧面板（约 360px、可折叠、可拖拽调宽） */
export function AiPanel() {
  const open = useAiStore((s) => s.open);
  const width = useAiStore((s) => s.width);
  const messages = useAiStore((s) => s.messages);
  const sessions = useAiStore((s) => s.sessions);
  const reasoning = useAiStore((s) => s.reasoning);
  const streaming = useAiStore((s) => s.streaming);
  const retrieving = useAiStore((s) => s.retrieving);
  const error = useAiStore((s) => s.error);
  const errorCode = useAiStore((s) => s.errorCode);
  const usage = useAiStore((s) => s.usage);
  const usageTotal = useAiStore((s) => s.usageTotal);
  const usageSummary = useAiStore((s) => s.usageSummary);
  const pendingContext = useAiStore((s) => s.pendingContext);
  const setPendingContext = useAiStore((s) => s.setPendingContext);
  const focusTick = useAiStore((s) => s.focusTick);
  const config = useAiStore((s) => s.config);
  const configLoaded = useAiStore((s) => s.configLoaded);
  const closePanel = useAiStore((s) => s.closePanel);
  const setWidth = useAiStore((s) => s.setWidth);
  const loadConfig = useAiStore((s) => s.loadConfig);
  const loadSessions = useAiStore((s) => s.loadSessions);
  const sessionsLoaded = useAiStore((s) => s.sessionsLoaded);
  const sessionsShown = useAiStore((s) => s.sessionsShown);
  const loadMoreSessions = useAiStore((s) => s.loadMoreSessions);
  const switchProfile = useAiStore((s) => s.switchProfile);
  const setCtxScope = useAiStore((s) => s.setCtxScope);
  const runQuickAction = useAiStore((s) => s.runQuickAction);
  const continueGenerate = useAiStore((s) => s.continueGenerate);
  const send = useAiStore((s) => s.send);
  const stop = useAiStore((s) => s.stop);
  const clear = useAiStore((s) => s.clear);
  const retry = useAiStore((s) => s.retry);
  const quickAction = useAiStore((s) => s.quickAction);
  const undoAction = useAiStore((s) => s.undoAction);
  const newChat = useAiStore((s) => s.newChat);
  const switchSession = useAiStore((s) => s.switchSession);
  const activeSessionId = useAiStore((s) => s.activeSessionId);
  const deleteSession = useAiStore((s) => s.deleteSession);
  const renameSession = useAiStore((s) => s.renameSession);
  const setSessionArchived = useAiStore((s) => s.setSessionArchived);
  const rateMessage = useAiStore((s) => s.rateMessage);
  const applyAction = useAiStore((s) => s.applyAction);
  const rejectAction = useAiStore((s) => s.rejectAction);
  const editingId = useAiStore((s) => s.editingId);
  const promptIdeas = useAiStore((s) => s.promptIdeas);
  const refining = useAiStore((s) => s.refining);
  const regenerate = useAiStore((s) => s.regenerate);
  const resend = useAiStore((s) => s.resend);
  const startEdit = useAiStore((s) => s.startEdit);
  const cancelEdit = useAiStore((s) => s.cancelEdit);
  const branchFrom = useAiStore((s) => s.branchFrom);
  const saveMessageAsPage = useAiStore((s) => s.saveMessageAsPage);
  const exportMessage = useAiStore((s) => s.exportMessage);
  const refinePrompt = useAiStore((s) => s.refinePrompt);
  const clearPromptIdeas = useAiStore((s) => s.clearPromptIdeas);
  const setRoute = useWorkspaceStore((s) => s.setRoute);

  const [input, setInput] = useState("");
  // 待发送的图片附件（assets/ 相对路径）；发送后随消息留在对话里
  const [attachments, setAttachments] = useState<AiImageAttachment[]>([]);
  // 正在查看的改动对比（AI 下发的某个动作 + 所属消息与下标，便于弹窗内直接「应用」）
  const [diff, setDiff] = useState<{ id: string; index: number; record: AiActionRecord } | null>(null);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionActive, setMentionActive] = useState(0);
  const [showHistory, setShowHistory] = useState(false);
  // 破坏性操作（清空当前对话 / 删除会话）先确认：这些都会直接删库里的会话行
  const [pendingDanger, setPendingDanger] = useState<{ kind: "clear" } | { kind: "session"; id: string } | null>(null);
  // 历史会话面板：搜索词 + 是否在看归档区 + 正在改名的那一行
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyArchived, setHistoryArchived] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  // 是否停留在列表底部：流式增量只在此时自动跟随，用户上滑看历史不被拽回
  const [pinned, setPinned] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const tree = useWorkspaceStore((s) => s.tree);

  // @ 引用的候选文档：当前工作区树（排除行详情），按查询词模糊匹配打分取前 8
  const mentionItems = useMemo(() => {
    if (!mention) return [];
    return flattenTree(tree)
      .flatMap((v) => {
        try {
          if ((JSON.parse(v.extra) as { row_detail?: unknown }).row_detail) return [];
        } catch {
          /* extra 解析失败当作普通文档 */
        }
        // 标题与别名一起打分取最高：@ 缩写/旧名也能把这页带进候选
        const score = bestMentionScore([v.name, ...parseViewAliases(v.aliases)], mention.query);
        return score === null ? [] : [{ v, score }];
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((x) => x.v);
  }, [mention, tree]);

  useEffect(() => {
    if (open && !configLoaded) void loadConfig();
  }, [open, configLoaded, loadConfig]);

  // 历史会话从库里恢复（首次打开面板时）
  useEffect(() => {
    if (open && !sessionsLoaded) void loadSessions();
  }, [open, sessionsLoaded, loadSessions]);

  const scrollToBottom = () => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  // 新消息/流式增量时滚到底部——仅当用户停在底部附近；上滑阅读历史时不打断
  useEffect(() => {
    if (pinned) scrollToBottom();
  }, [messages, reasoning, streaming, pinned]);

  // 切换/新建会话后回到底部并恢复跟随
  useEffect(() => {
    setPinned(true);
  }, [activeSessionId]);

  // 从编辑器（浮动工具栏 / 斜杠菜单 / 命令面板）唤起时把光标交给输入框
  useEffect(() => {
    if (open && focusTick > 0) textareaRef.current?.focus();
  }, [open, focusTick]);

  // ——— 消息气泡操作集（必须在 !open 提前返回之前定义，useCallback/UseMemo 是 hook）———
  // 逐个内联箭头传给 MessageBubble 会击穿 memo：流式每来一个 token，
  // 所有历史气泡全量重渲。这里把消息级操作收敛成一个引用稳定的 api 对象，
  // 气泡内部按 message 自身内容决定是否展示/如何调用。
  const copyMessage = useCallback((text: string) => {
    if (!text.trim()) return;
    navigator.clipboard.writeText(text).then(
      () => toast.success(t("ai.copied")),
      (e: unknown) => toast.error(aiErrorText(e)),
    );
  }, []);

  // 把文本填回输入框并把光标移到末尾（改提问、采用改写候选都走这里）
  const fillInput = useCallback((text: string) => {
    setInput(text);
    setMention(null);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, []);

  // 改后重发的入口：标记目标提问，同时把原文填回输入框等用户改完再发送
  const editMessage = useCallback(
    (message: AiMessage) => {
      startEdit(message.id);
      fillInput(message.content);
    },
    [startEdit, fillInput],
  );

  // 回填：把助手回答写入文档（替换选区 / 光标处插入）
  const writeBack = useCallback((text: string, mode: "replace" | "insert") => {
    const bridge = getAiEditor();
    if (!bridge) {
      toast.error(t("ai.noEditor"));
      return;
    }
    if (mode === "replace") {
      bridge.replaceSelection(text);
      toast.success(t("ai.replaced"));
    } else {
      bridge.insertAtCursor(text);
      toast.success(t("ai.inserted"));
    }
  }, []);

  const bubbleApi = useMemo<BubbleApi>(
    () => ({
      copy: copyMessage,
      regenerate: (id) => void regenerate(id),
      edit: editMessage,
      savePage: (id) => void saveMessageAsPage(id),
      exportMsg: (id) => void exportMessage(id),
      branch: (id) => branchFrom(id),
      rate: (id, rating) => rateMessage(id, rating),
      writeBack,
      undo: (msgId, index) => void undoAction(msgId, index),
      apply: (msgId, index) => void applyAction(msgId, index),
      reject: (msgId, index) => rejectAction(msgId, index),
      viewDiff: (msgId, index, record) => setDiff({ id: msgId, index, record }),
    }),
    [
      copyMessage,
      editMessage,
      writeBack,
      regenerate,
      saveMessageAsPage,
      exportMessage,
      branchFrom,
      rateMessage,
      undoAction,
      applyAction,
      rejectAction,
    ],
  );

  if (!open) return null;

  // 最后一条是 AI 的半截回答（被手动停止或超时中断）时，才提供「继续生成」
  const canContinue = !streaming && messages.length > 0 && messages[messages.length - 1].role === "assistant";
  const errorHint = errorCode ? AI_ERROR_HINT[errorCode] : undefined;
  const configured = !!config && config.enabled && !!config.base_url && !!config.model;
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant" && m.content.trim().length > 0);

  // 费用估算：按设置里的「每 100 万 token 单价」算，未填价时 estimateAiCost 返回 null（不显示金额）
  const priceIn = config?.price_input ?? 0;
  const priceOut = config?.price_output ?? 0;
  const sessionCost = estimateAiCost(usageTotal, priceIn, priceOut);
  const allCost = usageSummary
    ? estimateAiCost(
        { prompt: usageSummary.prompt_tokens, completion: usageSummary.completion_tokens },
        priceIn,
        priceOut,
      )
    : null;
  const showUsage = !!usage || usageTotal.total > 0 || !!usageSummary;

  // 历史列表只在面板展开时算：正文逐条比对不便宜，没必要跟着流式增量每帧跑一遍。
  // 先取显示窗口（归档全留 + 最近 MAX_SESSIONS×n 条普通会话），再按分区/关键词筛。
  const windowedSessions = showHistory ? visibleSessionWindow(sessions, sessionsShown) : [];
  const hiddenNormalCount = showHistory ? sessions.length - windowedSessions.length : 0;
  const archivedCount = showHistory ? sessions.filter((x) => x.archived).length : 0;
  const historyList = showHistory ? filterHistorySessions(windowedSessions, historyArchived, historyQuery) : [];

  const closeHistory = () => {
    setShowHistory(false);
    setRenamingId(null);
  };

  const commitRename = (id: string) => {
    renameSession(id, renameDraft);
    setRenamingId(null);
  };

  // 用户滚动时重新判断是否停在底部（48px 容差）
  const onListScroll = () => {
    const el = listRef.current;
    if (!el) return;
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
  };

  const submit = () => {
    const text = input.trim();
    if ((!text && attachments.length === 0) || streaming) return;
    setInput("");
    setAttachments([]);
    setMention(null);
    setPinned(true);
    // 正在修改某条提问时，发送表示「改后重发」：替换那条提问并重跑它之后的回答
    // 没重新附图就沿用原提问的图片（传 undefined 表示不改）
    const images = attachments.length > 0 ? attachments : undefined;
    if (editingId) void resend(editingId, text, images);
    else void send(text, images);
  };

  // 图片附件：粘贴与选择框拿到的都是 File，先落进 assets/，会话与请求里只带相对路径
  const addImageFiles = async (files: File[]) => {
    const room = MAX_AI_IMAGES - attachments.length;
    if (room <= 0) {
      toast.error(t("ai.attachFull", { count: MAX_AI_IMAGES }));
      return;
    }
    const saved: AiImageAttachment[] = [];
    for (const file of files.slice(0, room)) {
      try {
        saved.push(await saveAiImageFile(file));
      } catch (e) {
        toast.error(aiErrorText(e));
      }
    }
    if (saved.length > 0) setAttachments((cur) => [...cur, ...saved].slice(0, MAX_AI_IMAGES));
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = filesFromDataTransfer(e.clipboardData);
    // 纯文本粘贴不拦截，交回输入框默认行为
    if (files.length === 0) return;
    e.preventDefault();
    void addImageFiles(files);
  };

  const removeAttachment = (path: string) => setAttachments((cur) => cur.filter((i) => i.path !== path));

  const stopEdit = () => {
    cancelEdit();
    setInput("");
  };

  // 选中 @ 引用：把 @查询词 替换为 @文件名 （带一个尾随空格），并把光标移到其后
  const pickMention = (name: string) => {
    if (!mention) return;
    const caret = textareaRef.current?.selectionStart ?? input.length;
    const next = input.slice(0, mention.start) + "@" + name + " " + input.slice(caret);
    setInput(next);
    setMention(null);
    const pos = mention.start + name.length + 2;
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(pos, pos);
      }
    });
  };

  const onInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setInput(value);
    setMention(detectMentionQuery(value, e.target.selectionStart));
    setMentionActive(0);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 文件下拉打开时，方向键/回车/退出优先归下拉
    if (mention && mentionItems.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionActive((i) => (i + 1) % mentionItems.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionActive((i) => (i - 1 + mentionItems.length) % mentionItems.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickMention(mentionItems[mentionActive]?.name ?? mentionItems[0].name);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMention(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const copyLast = () => {
    copyMessage(lastAssistant?.content ?? "");
  };

  // 拖拽左边缘调宽：向左拖变宽
  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: MouseEvent) => setWidth(startW + (startX - ev.clientX));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div
      data-testid="ai-panel"
      role="complementary"
      aria-label={t("ai.title")}
      className="relative flex h-full shrink-0 flex-col border-l border-neutral-200 bg-white dark:border-neutral-700 dark:bg-neutral-900"
      style={{ width }}
    >
      <div
        className="absolute inset-y-0 left-0 z-10 w-1 cursor-col-resize bg-transparent transition-colors hover:bg-brand-400"
        title={t("ai.dragHint")}
        role="separator"
        aria-orientation="vertical"
        aria-label={t("ai.dragHint")}
        onMouseDown={startDrag}
      />

      {/* 头部：标题 + 新对话 / 历史 / 清空 / 复制 / 收起 */}
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-neutral-200 px-2 dark:border-neutral-700">
        <Sparkles className="h-3.5 w-3.5 text-brand-500" />
        <span className="text-[13px] font-medium text-neutral-800 dark:text-neutral-200">{t("ai.title")}</span>
        <div className="ml-auto flex items-center gap-0.5">
          <button
            className="flex h-6 w-6 items-center justify-center rounded text-neutral-500 hover:bg-neutral-200 dark:hover:bg-neutral-700"
            title={t("ai.newChat")}
            aria-label={t("ai.newChat")}
            onClick={newChat}
          >
            <MessageSquarePlus className="h-3.5 w-3.5" />
          </button>
          <button
            className="flex h-6 w-6 items-center justify-center rounded text-neutral-500 hover:bg-neutral-200 disabled:opacity-40 dark:hover:bg-neutral-700"
            title={t("ai.history")}
            aria-label={t("ai.history")}
            aria-expanded={showHistory}
            disabled={sessions.length === 0}
            onClick={() => setShowHistory((v) => !v)}
          >
            <History className="h-3.5 w-3.5" />
          </button>
          <button
            className="flex h-6 w-6 items-center justify-center rounded text-neutral-500 hover:bg-neutral-200 disabled:opacity-40 dark:hover:bg-neutral-700"
            title={t("ai.clear")}
            aria-label={t("ai.clear")}
            disabled={messages.length === 0}
            onClick={() => setPendingDanger({ kind: "clear" })}
          >
            <Eraser className="h-3.5 w-3.5" />
          </button>
          <button
            className="flex h-6 w-6 items-center justify-center rounded text-neutral-500 hover:bg-neutral-200 disabled:opacity-40 dark:hover:bg-neutral-700"
            title={t("ai.copy")}
            aria-label={t("ai.copy")}
            disabled={!lastAssistant}
            onClick={copyLast}
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
          <button
            className="flex h-6 w-6 items-center justify-center rounded text-neutral-500 hover:bg-neutral-200 dark:hover:bg-neutral-700"
            title={t("ai.close")}
            aria-label={t("ai.close")}
            onClick={closePanel}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* 历史会话下拉：可搜索、可改名/归档；切换时当前对话自动归档 */}
      {showHistory && (
        <>
          <button
            className="fixed inset-0 z-20 cursor-default"
            aria-label={t("ai.closeHistory")}
            onClick={closeHistory}
          />
          <div className="absolute top-9 right-2 z-30 w-72 overflow-hidden rounded-md border border-neutral-200 bg-white shadow-lg dark:border-neutral-700 dark:bg-neutral-800">
            <div className="flex items-center gap-1.5 border-b border-neutral-200 px-2.5 py-1.5 dark:border-neutral-700">
              <Search className="h-3 w-3 shrink-0 text-neutral-400" />
              <input
                autoFocus
                value={historyQuery}
                onChange={(e) => setHistoryQuery(e.target.value)}
                placeholder={t("ai.searchSessions")}
                aria-label={t("ai.searchSessions")}
                className="min-w-0 flex-1 bg-transparent text-[12px] text-neutral-700 outline-none placeholder:text-neutral-400 dark:text-neutral-200"
              />
            </div>
            <div className="flex gap-1 px-2 pt-1.5">
              {[false, true].map((flag) => (
                <button
                  key={String(flag)}
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[11px] text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-700",
                    historyArchived === flag &&
                      "bg-neutral-100 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200",
                  )}
                  onClick={() => setHistoryArchived(flag)}
                >
                  {flag ? t("ai.historyArchivedTab") : t("ai.historyRecentTab")}
                  {flag && archivedCount > 0 ? ` · ${archivedCount}` : ""}
                </button>
              ))}
            </div>
            <div className="max-h-64 overflow-y-auto py-1">
              {historyList.length === 0 ? (
                <p className="px-3 py-2 text-[11px] text-neutral-400">{t("ai.noSessionMatch")}</p>
              ) : (
                historyList.map((sess) => (
                  <div key={sess.id} className="group flex items-center pr-1">
                    {renamingId === sess.id ? (
                      <input
                        autoFocus
                        value={renameDraft}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onBlur={() => commitRename(sess.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitRename(sess.id);
                          else if (e.key === "Escape") setRenamingId(null);
                        }}
                        aria-label={t("ai.renameSessionField")}
                        className="mx-1.5 my-0.5 min-w-0 flex-1 rounded border border-brand-500 bg-white px-1.5 py-1 text-[12px] text-neutral-700 outline-none dark:bg-neutral-900 dark:text-neutral-200"
                      />
                    ) : (
                      <button
                        className="min-w-0 flex-1 truncate rounded px-2.5 py-1.5 text-left text-[12px] text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-700"
                        onClick={() => {
                          switchSession(sess.id);
                          closeHistory();
                        }}
                      >
                        {sess.title}
                        {/* 标注这个会话是基于哪一页问的，避免切页后张冠李戴 */}
                        {sess.pageTitle && (
                          <span className="ml-1 text-[10px] text-neutral-400">· {sess.pageTitle}</span>
                        )}
                      </button>
                    )}
                    {renamingId !== sess.id && (
                      <>
                        <RowAction
                          icon={<PenLine className="h-3 w-3" />}
                          label={t("ai.renameSession")}
                          onClick={() => {
                            setRenamingId(sess.id);
                            setRenameDraft(sess.title);
                          }}
                        />
                        <RowAction
                          icon={
                            sess.archived ? <ArchiveRestore className="h-3 w-3" /> : <Archive className="h-3 w-3" />
                          }
                          label={sess.archived ? t("ai.unarchiveSession") : t("ai.archiveSession")}
                          onClick={() => setSessionArchived(sess.id, !sess.archived)}
                        />
                        <RowAction
                          icon={<Trash2 className="h-3 w-3" />}
                          label={t("ai.deleteSession")}
                          danger
                          onClick={() => setPendingDanger({ kind: "session", id: sess.id })}
                        />
                      </>
                    )}
                  </div>
                ))
              )}
              {!historyArchived && hiddenNormalCount > 0 && (
                <button
                  className="block w-full px-3 py-1.5 text-left text-[11px] text-brand-600 hover:bg-neutral-100 dark:hover:bg-neutral-700"
                  onClick={loadMoreSessions}
                >
                  {t("ai.loadMoreSessions")}（{t("ai.moreSessionCount", { count: hiddenNormalCount })}）
                </button>
              )}
            </div>
          </div>
        </>
      )}

      {!configLoaded ? (
        <div className="flex flex-1 items-center justify-center text-xs text-neutral-400">{t("app.loading")}</div>
      ) : !configured ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <Sparkles className="h-6 w-6 text-neutral-300" />
          <div>
            <p className="text-[13px] font-medium text-neutral-700 dark:text-neutral-200">{t("ai.notConfigured")}</p>
            <p className="mt-1 text-[11px] text-neutral-500">{t("ai.notConfiguredHint")}</p>
          </div>
          <Button size="sm" onClick={() => setRoute("settings")}>
            <Settings className="mr-1 h-3.5 w-3.5" />
            {t("ai.goSettings")}
          </Button>
        </div>
      ) : (
        <>
          <div className="relative flex min-h-0 flex-1 flex-col">
            <div
              ref={listRef}
              onScroll={onListScroll}
              role="log"
              aria-live="polite"
              aria-label={t("ai.title")}
              className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3"
            >
              {messages.length === 0 && (
                <p className="mt-6 text-center text-[12px] text-neutral-400">{t("ai.empty")}</p>
              )}
              {/* 隐私提示：本地优先的应用，明确告知这一轮会发到哪个服务商 */}
              <p className="px-2 pb-1 text-[11px] text-neutral-400">
                {t("ai.sendHint", { host: safeHost(config.base_url) })}
              </p>
              {messages.map((m) => (
                <MessageBubble key={m.id} message={m} busy={streaming} api={bubbleApi} />
              ))}
              {/* 推理型模型的思考过程：流式时展开，结束后折叠保留，方便回看模型是怎么想的 */}
              {reasoning && (
                <details
                  open={streaming}
                  className="rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1.5 text-[11px] text-neutral-500 dark:border-neutral-700 dark:bg-neutral-800/50 dark:text-neutral-400"
                >
                  <summary className="cursor-pointer font-medium">{t("ai.reasoning")}</summary>
                  <div className="mt-1 max-h-32 overflow-y-auto break-words whitespace-pre-wrap">{reasoning}</div>
                </details>
              )}
              {/* 检索执行期间也在 streaming：这时思考过程可能已展开，仍要说明前端在忙什么 */}
              {streaming && (retrieving || !reasoning) && (
                <p className="text-[11px] text-neutral-400">{retrieving ? t("ai.toolRunning") : t("ai.thinking")}</p>
              )}
              {/* 被中断/超时的回答可以接着往下写：把半截内容留在上下文里再问一次 */}
              {!streaming && canContinue && (
                <div className="px-2 pb-1">
                  <button
                    className="rounded-md border border-neutral-200 px-2 py-0.5 text-[11px] text-neutral-600 hover:border-brand-400 hover:bg-brand-50 hover:text-brand-700 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                    onClick={() => void continueGenerate()}
                  >
                    {t("ai.continueGenerate")}
                  </button>
                </div>
              )}
              {error && (
                <div className="rounded-md border border-red-200 bg-red-50 px-2.5 py-2 text-[11px] text-red-600">
                  {t("ai.errorPrefix", { message: error })}
                  {/* 按错误归类给出对应的处理办法，而不是让所有失败都停在「请求失败」 */}
                  {errorHint && <p className="mt-0.5">{t(errorHint)}</p>}
                  <button className="ml-2 underline hover:no-underline" onClick={() => void retry()}>
                    {t("ai.retry")}
                  </button>
                </div>
              )}
            </div>
            {/* 上滑离开底部后流式不再强拉；一键回到最新消息 */}
            {!pinned && (
              <button
                className="absolute bottom-2 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full border border-neutral-200 bg-white px-2.5 py-1 text-[11px] text-neutral-600 shadow-md hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
                onClick={() => {
                  setPinned(true);
                  scrollToBottom();
                }}
              >
                <ArrowDown className="h-3 w-3" />
                {t("ai.scrollToBottom")}
              </button>
            )}
          </div>

          {/* token 用量：本轮/本会话要服务商返回 usage 才有，跨会话累计与费用估算随时可见 */}
          {showUsage && (
            <div className="flex flex-wrap gap-x-2 border-t border-neutral-200 px-2 py-1 text-[11px] text-neutral-400 dark:border-neutral-700">
              {usage && (
                <span>
                  {t("ai.usageLast", {
                    prompt: (usage.prompt_tokens ?? 0).toLocaleString(),
                    completion: (usage.completion_tokens ?? 0).toLocaleString(),
                  })}
                </span>
              )}
              {usageTotal.total > 0 && (
                <span>
                  {t("ai.usageTotal", { total: usageTotal.total.toLocaleString() })}
                  {sessionCost !== null && ` · ${t("ai.usageCost", { amount: formatAiCost(sessionCost) })}`}
                </span>
              )}
              {usageSummary && usageSummary.prompt_tokens + usageSummary.completion_tokens > 0 && (
                <span title={t("ai.usageAllTitle")}>
                  {t("ai.usageAll", {
                    sessions: usageSummary.sessions,
                    total: (usageSummary.prompt_tokens + usageSummary.completion_tokens).toLocaleString(),
                  })}
                  {allCost !== null && ` · ${t("ai.usageCost", { amount: formatAiCost(allCost) })}`}
                </span>
              )}
            </div>
          )}

          {/* 快捷动作：内置四项 + 用户在设置里自定义的指令；有档位时可在最前面切换 */}
          <div className="flex flex-wrap gap-1 border-t border-neutral-200 px-2 py-1.5 dark:border-neutral-700">
            {/* 模型档位切换：只在配置里存在档位时出现 */}
            {config.profiles.length > 0 && (
              <select
                value={config.active_profile}
                onChange={(e) => void switchProfile(e.target.value)}
                disabled={streaming}
                title={t("settings.aiProfiles")}
                aria-label={t("settings.aiProfiles")}
                className="h-6 max-w-[9rem] rounded-md border border-neutral-200 bg-white px-1 text-[11px] text-neutral-600 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
              >
                <option value="">{t("ai.profileDefault")}</option>
                {config.profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name || p.model || p.id}
                  </option>
                ))}
              </select>
            )}
            {/* 上下文范围：面板里直接切，省得为「别带我这页内容」跑一趟设置页 */}
            <select
              value={["page_only", "off"].includes(config.ctx_scope) ? config.ctx_scope : "full"}
              onChange={(e) => void setCtxScope(e.target.value)}
              disabled={streaming}
              title={t("ai.ctxScopeTitle")}
              aria-label={t("ai.ctxScopeTitle")}
              className="h-6 max-w-[9rem] rounded-md border border-neutral-200 bg-white px-1 text-[11px] text-neutral-600 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
            >
              <option value="full">{t("ai.ctxScopeFull")}</option>
              <option value="page_only">{t("ai.ctxScopePageOnly")}</option>
              <option value="off">{t("ai.ctxScopeOff")}</option>
            </select>
            <QuickButton
              icon={<FileText className="h-3 w-3" />}
              label={t("ai.summarize")}
              disabled={streaming}
              onClick={() => void quickAction("summarize")}
            />
            <QuickButton
              icon={<Languages className="h-3 w-3" />}
              label={t("ai.translate")}
              disabled={streaming}
              onClick={() => void quickAction("translate")}
            />
            <QuickButton
              icon={<PenLine className="h-3 w-3" />}
              label={t("ai.rewrite")}
              disabled={streaming}
              onClick={() => void quickAction("rewrite")}
            />
            <QuickButton
              icon={<Lightbulb className="h-3 w-3" />}
              label={t("ai.explain")}
              disabled={streaming}
              onClick={() => void quickAction("explain")}
            />
            <QuickButton
              icon={<Sparkles className="h-3 w-3" />}
              label={t("ai.continue")}
              disabled={streaming}
              onClick={() => void quickAction("continue")}
            />
            {/* 用户自定义快捷指令（设置里维护） */}
            {config.quick_actions.map((a) => (
              <QuickButton
                key={a.id}
                icon={<Sparkles className="h-3 w-3" />}
                label={a.name || t("ai.customAction")}
                disabled={streaming}
                onClick={() => void runQuickAction(a)}
              />
            ))}
          </div>

          {/* 输入区：Enter 发送、Shift+Enter 换行；输入 @ 引用工作区文件 */}
          <div className="relative shrink-0 border-t border-neutral-200 p-2 dark:border-neutral-700">
            {/* 改后重发：输入框内容对应一条既有提问，发送会替换它并重跑其后的回答 */}
            {editingId && (
              <div className="mb-1 flex items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-700 dark:border-amber-600 dark:bg-neutral-800 dark:text-amber-300">
                <span className="min-w-0 flex-1">{t("ai.editingBanner")}</span>
                <button className="shrink-0 underline hover:no-underline" onClick={stopEdit}>
                  {t("ai.cancelMsgEdit")}
                </button>
              </div>
            )}
            {/* 「优化提问」的候选：点一条填回输入框 */}
            {promptIdeas.length > 0 && (
              <div className="mb-1 rounded-md border border-neutral-200 px-2 py-1 dark:border-neutral-700">
                <div className="flex items-center justify-between text-[11px] text-neutral-500">
                  <span>{t("ai.refineCandidates")}</span>
                  <button className="underline hover:no-underline" onClick={clearPromptIdeas}>
                    {t("ai.clearPendingContext")}
                  </button>
                </div>
                <div className="mt-1 space-y-1">
                  {promptIdeas.map((idea, i) => (
                    <button
                      key={i}
                      type="button"
                      title={idea}
                      className="block w-full truncate rounded border border-neutral-200 px-1.5 py-0.5 text-left text-[11px] text-neutral-600 hover:border-brand-400 hover:bg-brand-50 hover:text-brand-700 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                      onClick={() => {
                        fillInput(idea);
                        clearPromptIdeas();
                      }}
                    >
                      {idea}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {/* 编辑器带入的选中内容：随本轮提问一起下发 */}
            {pendingContext && (
              <div className="mb-1 flex items-center gap-1.5 rounded-md border border-brand-300 bg-brand-50 px-2 py-1 text-[11px] text-brand-700 dark:border-brand-600 dark:bg-neutral-800 dark:text-neutral-200">
                <span className="min-w-0 flex-1 truncate">
                  {t("ai.pendingContext", { count: pendingContext.length })}
                </span>
                <button className="shrink-0 underline hover:no-underline" onClick={() => setPendingContext(null)}>
                  {t("ai.clearPendingContext")}
                </button>
              </div>
            )}
            {/* 待发送的图片：缩略图 + 移除；发送后原样留在用户消息里 */}
            {attachments.length > 0 && (
              <div className="mb-1 flex flex-wrap gap-1.5">
                {attachments.map((img) => (
                  <ImageThumb
                    key={img.path}
                    path={img.path}
                    name={img.name}
                    onRemove={() => removeAttachment(img.path)}
                  />
                ))}
              </div>
            )}
            {mention && (
              <div className="absolute inset-x-2 bottom-full mb-1 overflow-hidden rounded-md border border-neutral-200 bg-white shadow-lg dark:border-neutral-700 dark:bg-neutral-800">
                {mentionItems.length === 0 ? (
                  <div className="px-3 py-2 text-[12px] text-neutral-400">{t("mention.empty")}</div>
                ) : (
                  <div role="listbox" aria-label={t("ai.inputPlaceholder")} className="max-h-56 overflow-y-auto py-1">
                    {mentionItems.map((v, i) => (
                      <button
                        key={v.id}
                        type="button"
                        role="option"
                        aria-selected={i === mentionActive}
                        data-active={i === mentionActive}
                        className={cn(
                          "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px]",
                          i === mentionActive
                            ? "bg-brand-100 text-neutral-800 dark:bg-neutral-700 dark:text-neutral-100"
                            : "text-neutral-600 dark:text-neutral-300",
                        )}
                        onMouseEnter={() => setMentionActive(i)}
                        onClick={() => pickMention(v.name)}
                      >
                        <span className="text-base leading-none">{viewIcon(v)}</span>
                        <span className="min-w-0 flex-1 truncate">{v.name || t("common.untitled")}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <textarea
              ref={textareaRef}
              value={input}
              onChange={onInputChange}
              onPaste={onPaste}
              onKeyDown={onKeyDown}
              rows={3}
              aria-label={t("ai.inputPlaceholder")}
              placeholder={t("ai.inputPlaceholder")}
              className="w-full resize-none rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-[12px] text-neutral-800 outline-none focus:border-brand-500 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-200"
            />
            <div className="mt-1.5 flex items-center justify-end gap-1.5">
              {/* 图片附件走隐藏的原生选择框：能拿到 File，体积/类型可在校验后再入库 */}
              <input
                ref={fileInputRef}
                type="file"
                accept={AI_IMAGE_ACCEPT}
                multiple
                aria-hidden="true"
                className="hidden"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  e.target.value = "";
                  if (files.length > 0) void addImageFiles(files);
                }}
              />
              <QuickButton
                icon={<ImagePlus className="h-3 w-3" />}
                label={t("ai.attachImage")}
                disabled={streaming || attachments.length >= MAX_AI_IMAGES}
                onClick={() => fileInputRef.current?.click()}
              />
              {/* 优化提问：让模型把输入框里这句改写成几条候选，不进对话 */}
              {!streaming && (
                <QuickButton
                  icon={<Sparkles className="h-3 w-3" />}
                  label={refining ? t("ai.refining") : t("ai.refine")}
                  disabled={!input.trim() || refining}
                  onClick={() => void refinePrompt(input)}
                />
              )}
              {streaming ? (
                <Button size="sm" variant="outline" onClick={stop}>
                  <Square className="mr-1 h-3.5 w-3.5" />
                  {t("ai.stop")}
                </Button>
              ) : (
                <Button size="sm" onClick={submit} disabled={!input.trim() && attachments.length === 0}>
                  <Send className="mr-1 h-3.5 w-3.5" />
                  {t("ai.send")}
                </Button>
              )}
            </div>
          </div>
        </>
      )}
      <EditDiffDialog
        record={diff?.record ?? null}
        open={!!diff}
        onOpenChange={(v) => {
          if (!v) setDiff(null);
        }}
        onApply={diff ? () => void applyAction(diff.id, diff.index) : undefined}
      />
      <ConfirmDialog
        open={pendingDanger !== null}
        onOpenChange={(v) => !v && setPendingDanger(null)}
        title={pendingDanger?.kind === "session" ? t("ai.confirmDeleteSessionTitle") : t("ai.confirmClearTitle")}
        description={
          pendingDanger?.kind === "session"
            ? t("ai.confirmDeleteSessionDesc", {
                title: sessions.find((x) => x.id === pendingDanger.id)?.title ?? "",
              })
            : t("ai.confirmClearDesc")
        }
        confirmLabel={t("common.delete")}
        onConfirm={() => {
          const danger = pendingDanger;
          setPendingDanger(null);
          if (!danger) return;
          if (danger.kind === "clear") clear();
          else deleteSession(danger.id);
        }}
      />
    </div>
  );
}
