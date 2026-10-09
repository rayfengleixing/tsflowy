import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Copy,
  CornerDownLeft,
  Eraser,
  FileText,
  History,
  Languages,
  Lightbulb,
  MessageSquarePlus,
  PenLine,
  Replace,
  Send,
  Settings,
  Sparkles,
  Square,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { viewIcon } from "@/components/view-icon";
import { useAiStore, type AiEditRecord, type AiMessage } from "@/stores/ai";
import { useWorkspaceStore } from "@/stores/workspace";
import { aiErrorText } from "@/lib/ai";
import { getAiEditor } from "@/lib/ai-editor";
import { detectMentionQuery } from "@/lib/ai-mention";
import { flattenTree } from "@/lib/tree";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { EditDiffDialog } from "./EditDiffDialog";
import { Markdown } from "./Markdown";

/** AI 助手右侧面板（约 360px、可折叠、可拖拽调宽） */
export function AiPanel() {
  const open = useAiStore((s) => s.open);
  const width = useAiStore((s) => s.width);
  const messages = useAiStore((s) => s.messages);
  const sessions = useAiStore((s) => s.sessions);
  const reasoning = useAiStore((s) => s.reasoning);
  const streaming = useAiStore((s) => s.streaming);
  const error = useAiStore((s) => s.error);
  const usage = useAiStore((s) => s.usage);
  const usageTotal = useAiStore((s) => s.usageTotal);
  const pendingContext = useAiStore((s) => s.pendingContext);
  const setPendingContext = useAiStore((s) => s.setPendingContext);
  const focusTick = useAiStore((s) => s.focusTick);
  const config = useAiStore((s) => s.config);
  const configLoaded = useAiStore((s) => s.configLoaded);
  const closePanel = useAiStore((s) => s.closePanel);
  const setWidth = useAiStore((s) => s.setWidth);
  const loadConfig = useAiStore((s) => s.loadConfig);
  const send = useAiStore((s) => s.send);
  const stop = useAiStore((s) => s.stop);
  const clear = useAiStore((s) => s.clear);
  const retry = useAiStore((s) => s.retry);
  const quickAction = useAiStore((s) => s.quickAction);
  const undoEdit = useAiStore((s) => s.undoEdit);
  const newChat = useAiStore((s) => s.newChat);
  const switchSession = useAiStore((s) => s.switchSession);
  const deleteSession = useAiStore((s) => s.deleteSession);
  const applyPendingEdit = useAiStore((s) => s.applyPendingEdit);
  const rejectPendingEdit = useAiStore((s) => s.rejectPendingEdit);
  const setRoute = useWorkspaceStore((s) => s.setRoute);

  const [input, setInput] = useState("");
  // 正在查看的改动对比（AI 建议的编辑指令 + 所属消息，便于弹窗内直接「应用」）
  const [diff, setDiff] = useState<{ id: string; record: AiEditRecord } | null>(null);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionActive, setMentionActive] = useState(0);
  const [showHistory, setShowHistory] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const tree = useWorkspaceStore((s) => s.tree);

  // @ 引用的候选文档：当前工作区树（排除行详情），按查询词过滤
  const mentionItems = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.trim().toLowerCase();
    return flattenTree(tree)
      .filter((v) => {
        try {
          return !(JSON.parse(v.extra) as { row_detail?: unknown }).row_detail;
        } catch {
          return true;
        }
      })
      .filter((v) => !q || v.name.toLowerCase().includes(q))
      .slice(0, 8);
  }, [mention, tree]);

  useEffect(() => {
    if (open && !configLoaded) void loadConfig();
  }, [open, configLoaded, loadConfig]);

  // 新消息/流式增量时滚到底部
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, reasoning, streaming]);

  // 从编辑器（浮动工具栏 / 斜杠菜单 / 命令面板）唤起时把光标交给输入框
  useEffect(() => {
    if (open && focusTick > 0) textareaRef.current?.focus();
  }, [open, focusTick]);

  if (!open) return null;

  const configured = !!config && config.enabled && config.has_api_key && !!config.base_url && !!config.model;
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant" && m.content.trim().length > 0);

  const submit = () => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");
    setMention(null);
    void send(text);
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
    if (!lastAssistant) return;
    navigator.clipboard.writeText(lastAssistant.content).then(
      () => toast.success(t("ai.copied")),
      (e: unknown) => toast.error(aiErrorText(e)),
    );
  };

  // 回填：把助手回答写入文档（替换选区 / 光标处插入）
  const writeBack = (text: string, mode: "replace" | "insert") => {
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
      className="relative flex h-full shrink-0 flex-col border-l border-neutral-200 bg-white dark:border-neutral-700 dark:bg-neutral-900"
      style={{ width }}
    >
      <div
        className="absolute inset-y-0 left-0 z-10 w-1 cursor-col-resize bg-transparent transition-colors hover:bg-brand-400"
        title={t("ai.dragHint")}
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
            onClick={newChat}
          >
            <MessageSquarePlus className="h-3.5 w-3.5" />
          </button>
          <button
            className="flex h-6 w-6 items-center justify-center rounded text-neutral-500 hover:bg-neutral-200 disabled:opacity-40 dark:hover:bg-neutral-700"
            title={t("ai.history")}
            disabled={sessions.length === 0}
            onClick={() => setShowHistory((v) => !v)}
          >
            <History className="h-3.5 w-3.5" />
          </button>
          <button
            className="flex h-6 w-6 items-center justify-center rounded text-neutral-500 hover:bg-neutral-200 disabled:opacity-40 dark:hover:bg-neutral-700"
            title={t("ai.clear")}
            disabled={messages.length === 0}
            onClick={clear}
          >
            <Eraser className="h-3.5 w-3.5" />
          </button>
          <button
            className="flex h-6 w-6 items-center justify-center rounded text-neutral-500 hover:bg-neutral-200 disabled:opacity-40 dark:hover:bg-neutral-700"
            title={t("ai.copy")}
            disabled={!lastAssistant}
            onClick={copyLast}
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
          <button
            className="flex h-6 w-6 items-center justify-center rounded text-neutral-500 hover:bg-neutral-200 dark:hover:bg-neutral-700"
            title={t("ai.close")}
            onClick={closePanel}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* 历史会话下拉：点击切换（当前对话自动归档），悬浮可删除 */}
      {showHistory && (
        <>
          <button
            className="fixed inset-0 z-20 cursor-default"
            aria-label={t("ai.closeHistory")}
            onClick={() => setShowHistory(false)}
          />
          <div className="absolute top-9 right-2 z-30 w-64 overflow-hidden rounded-md border border-neutral-200 bg-white shadow-lg dark:border-neutral-700 dark:bg-neutral-800">
            <div className="max-h-72 overflow-y-auto py-1">
              {sessions.map((sess) => (
                <div key={sess.id} className="group flex items-center pr-1">
                  <button
                    className="min-w-0 flex-1 truncate rounded px-2.5 py-1.5 text-left text-[12px] text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-700"
                    onClick={() => {
                      switchSession(sess.id);
                      setShowHistory(false);
                    }}
                  >
                    {sess.title}
                  </button>
                  <button
                    className="shrink-0 rounded p-1 text-neutral-400 opacity-0 hover:text-red-500 group-hover:opacity-100"
                    title={t("ai.deleteSession")}
                    onClick={() => deleteSession(sess.id)}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
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
          <div ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
            {messages.length === 0 && <p className="mt-6 text-center text-[12px] text-neutral-400">{t("ai.empty")}</p>}
            {messages.map((m) => {
              const rec = m.edit;
              return (
                <MessageBubble
                  key={m.id}
                  message={m}
                  onReplace={m.role === "assistant" ? () => writeBack(m.content, "replace") : undefined}
                  onInsert={m.role === "assistant" ? () => writeBack(m.content, "insert") : undefined}
                  onUndo={rec ? () => undoEdit(m.id) : undefined}
                  onApply={rec?.state === "pending" ? () => applyPendingEdit(m.id) : undefined}
                  onReject={rec?.state === "pending" ? () => rejectPendingEdit(m.id) : undefined}
                  onViewDiff={rec && rec.state !== "malformed" ? () => setDiff({ id: m.id, record: rec }) : undefined}
                />
              );
            })}
            {/* 推理型模型（deepseek-flash / deepseek-reasoner 等）的思考过程：仅展示，不参与回填 */}
            {streaming && reasoning && (
              <div className="rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1.5 text-[11px] text-neutral-500 dark:border-neutral-700 dark:bg-neutral-800/50 dark:text-neutral-400">
                <p className="mb-1 font-medium">{t("ai.reasoning")}</p>
                <div className="max-h-32 overflow-y-auto break-words whitespace-pre-wrap">{reasoning}</div>
              </div>
            )}
            {streaming && !reasoning && <p className="text-[11px] text-neutral-400">{t("ai.thinking")}</p>}
            {error && (
              <div className="rounded-md border border-red-200 bg-red-50 px-2.5 py-2 text-[11px] text-red-600">
                {t("ai.errorPrefix", { message: error })}
                <button className="ml-2 underline hover:no-underline" onClick={() => void retry()}>
                  {t("ai.retry")}
                </button>
              </div>
            )}
          </div>

          {/* token 用量：服务商返回 usage 时才显示 */}
          {usage && (
            <div className="border-t border-neutral-200 px-2 py-1 text-[11px] text-neutral-400 dark:border-neutral-700">
              {t("ai.usageLast", {
                prompt: (usage.prompt_tokens ?? 0).toLocaleString(),
                completion: (usage.completion_tokens ?? 0).toLocaleString(),
              })}
              {usageTotal.total > 0 ? ` · ${t("ai.usageTotal", { total: usageTotal.total.toLocaleString() })}` : ""}
            </div>
          )}

          {/* 快捷动作：总结当前页 / 翻译选中 / 改写选中 / 解释选中 */}
          <div className="flex flex-wrap gap-1 border-t border-neutral-200 px-2 py-1.5 dark:border-neutral-700">
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
          </div>

          {/* 输入区：Enter 发送、Shift+Enter 换行；输入 @ 引用工作区文件 */}
          <div className="relative shrink-0 border-t border-neutral-200 p-2 dark:border-neutral-700">
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
            {mention && (
              <div className="absolute inset-x-2 bottom-full mb-1 overflow-hidden rounded-md border border-neutral-200 bg-white shadow-lg dark:border-neutral-700 dark:bg-neutral-800">
                {mentionItems.length === 0 ? (
                  <div className="px-3 py-2 text-[12px] text-neutral-400">{t("mention.empty")}</div>
                ) : (
                  <div className="max-h-56 overflow-y-auto py-1">
                    {mentionItems.map((v, i) => (
                      <button
                        key={v.id}
                        type="button"
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
              onKeyDown={onKeyDown}
              rows={3}
              placeholder={t("ai.inputPlaceholder")}
              className="w-full resize-none rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-[12px] text-neutral-800 outline-none focus:border-brand-500 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-200"
            />
            <div className="mt-1.5 flex items-center justify-end">
              {streaming ? (
                <Button size="sm" variant="outline" onClick={stop}>
                  <Square className="mr-1 h-3.5 w-3.5" />
                  {t("ai.stop")}
                </Button>
              ) : (
                <Button size="sm" onClick={submit} disabled={!input.trim()}>
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
        onApply={diff ? () => applyPendingEdit(diff.id) : undefined}
      />
    </div>
  );
}

function MessageBubble({
  message,
  onReplace,
  onInsert,
  onUndo,
  onApply,
  onReject,
  onViewDiff,
}: {
  message: AiMessage;
  onReplace?: () => void;
  onInsert?: () => void;
  onUndo?: () => void;
  onApply?: () => void;
  onReject?: () => void;
  onViewDiff?: () => void;
}) {
  const isUser = message.role === "user";
  const edit = message.edit;
  // 正文为空、内容被 summary 兜底时不再渲染气泡，避免与下方结果卡片重复
  const bubbleText = message.content === edit?.summary ? "" : message.content;
  return (
    <div className={cn("flex flex-col", isUser ? "items-end" : "items-start")}>
      {(bubbleText.trim() || !edit) &&
        (isUser ? (
          <div className="max-w-[85%] rounded-lg bg-brand-500 px-2.5 py-1.5 text-[12px] leading-relaxed whitespace-pre-wrap break-words text-white">
            {bubbleText || "…"}
          </div>
        ) : (
          // 助手回复走 Markdown 渲染（GFM 表格/代码块/链接），AI 输出不含原始 HTML，无注入风险
          <Markdown
            text={bubbleText || "…"}
            className="max-w-[85%] rounded-lg bg-neutral-100 px-2.5 py-1.5 text-neutral-800 dark:bg-neutral-800 dark:text-neutral-200"
          />
        ))}
      {/* AI 自主修改的落地结果：待确认 / 已写入 / 未写入 / 已忽略 / 指令有误，附查看改动与撤销 */}
      {edit && (
        <div className="mt-1.5 max-w-[85%]">
          <div
            className={cn(
              "flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px]",
              edit.state === "applied"
                ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
                : edit.state === "pending"
                  ? "border-brand-400 bg-brand-50 text-brand-700 dark:border-brand-500 dark:bg-neutral-800 dark:text-neutral-200"
                  : "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
            )}
          >
            {edit.state === "applied" ? (
              <Check className="h-3 w-3 shrink-0" />
            ) : edit.state === "pending" ? (
              <Sparkles className="h-3 w-3 shrink-0" />
            ) : (
              <TriangleAlert className="h-3 w-3 shrink-0" />
            )}
            <span className="min-w-0 flex-1 truncate">
              {edit.state === "applied"
                ? edit.undone
                  ? t("ai.editUndone")
                  : t("ai.editApplied")
                : edit.state === "pending"
                  ? t("ai.editPending")
                  : edit.state === "rejected"
                    ? t("ai.editRejected")
                    : edit.state === "malformed"
                      ? t("ai.editMalformed")
                      : t("ai.editNotApplied")}
              {edit.summary && !edit.undone && edit.state !== "malformed" ? `：${edit.summary}` : ""}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {onViewDiff && <MiniButton label={t("ai.viewDiff")} onClick={onViewDiff} />}
            {edit.state === "pending" && onApply && <MiniButton label={t("ai.applyEdit")} onClick={onApply} />}
            {edit.state === "pending" && onReject && <MiniButton label={t("ai.rejectEdit")} onClick={onReject} />}
            {edit.state === "applied" && !edit.undone && onUndo && (
              <MiniButton label={t("ai.undoEdit")} onClick={onUndo} />
            )}
          </div>
        </div>
      )}
      {!isUser && bubbleText.trim() && (onReplace ?? onInsert) && (
        <div className="mt-1.5 flex gap-1.5">
          {onReplace && (
            <button
              className="flex items-center gap-1 rounded-md border border-neutral-200 px-1.5 py-0.5 text-[11px] text-neutral-600 hover:border-brand-400 hover:bg-brand-50 hover:text-brand-700 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
              title={t("ai.replaceSelection")}
              onClick={onReplace}
            >
              <Replace className="h-3 w-3" />
              {t("ai.replaceSelection")}
            </button>
          )}
          {onInsert && (
            <button
              className="flex items-center gap-1 rounded-md border border-neutral-200 px-1.5 py-0.5 text-[11px] text-neutral-600 hover:border-brand-400 hover:bg-brand-50 hover:text-brand-700 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
              title={t("ai.insertToCursor")}
              onClick={onInsert}
            >
              <CornerDownLeft className="h-3 w-3" />
              {t("ai.insertToCursor")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** 消息卡片下方的小号操作按钮（查看改动 / 应用 / 忽略 / 撤销） */
function MiniButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      className="rounded-md border border-neutral-200 px-1.5 py-0.5 text-[11px] text-neutral-600 hover:border-brand-400 hover:bg-brand-50 hover:text-brand-700 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function QuickButton({
  icon,
  label,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className="flex items-center gap-1 rounded-md border border-neutral-200 px-1.5 py-0.5 text-[11px] text-neutral-600 hover:bg-neutral-100 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  );
}
