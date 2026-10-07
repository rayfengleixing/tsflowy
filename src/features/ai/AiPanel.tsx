import { useEffect, useRef, useState } from "react";
import {
  Copy,
  Eraser,
  FileText,
  Languages,
  Lightbulb,
  PenLine,
  Send,
  Settings,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useAiStore, type AiMessage } from "@/stores/ai";
import { useWorkspaceStore } from "@/stores/workspace";
import { aiErrorText } from "@/lib/ai";
import { getAiEditor } from "@/lib/ai-editor";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** AI 助手右侧面板（约 360px、可折叠、可拖拽调宽） */
export function AiPanel() {
  const open = useAiStore((s) => s.open);
  const width = useAiStore((s) => s.width);
  const messages = useAiStore((s) => s.messages);
  const reasoning = useAiStore((s) => s.reasoning);
  const streaming = useAiStore((s) => s.streaming);
  const error = useAiStore((s) => s.error);
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
  const setRoute = useWorkspaceStore((s) => s.setRoute);

  const [input, setInput] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && !configLoaded) void loadConfig();
  }, [open, configLoaded, loadConfig]);

  // 新消息/流式增量时滚到底部
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, reasoning, streaming]);

  if (!open) return null;

  const configured = !!config && config.enabled && config.has_api_key && !!config.base_url && !!config.model;
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant" && m.content.trim().length > 0);

  const submit = () => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");
    void send(text);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
    if (mode === "replace") bridge.replaceSelection(text);
    else bridge.insertAtCursor(text);
    toast.success(t("ai.inserted"));
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

      {/* 头部：标题 + 清空 / 复制 / 收起 */}
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-neutral-200 px-2 dark:border-neutral-700">
        <Sparkles className="h-3.5 w-3.5 text-brand-500" />
        <span className="text-[13px] font-medium text-neutral-800 dark:text-neutral-200">{t("ai.title")}</span>
        <div className="ml-auto flex items-center gap-0.5">
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
            {messages.map((m) => (
              <MessageBubble
                key={m.id}
                message={m}
                onReplace={m.role === "assistant" ? () => writeBack(m.content, "replace") : undefined}
                onInsert={m.role === "assistant" ? () => writeBack(m.content, "insert") : undefined}
              />
            ))}
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
          </div>

          {/* 输入区：Enter 发送、Shift+Enter 换行 */}
          <div className="shrink-0 border-t border-neutral-200 p-2 dark:border-neutral-700">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
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
    </div>
  );
}

function MessageBubble({
  message,
  onReplace,
  onInsert,
}: {
  message: AiMessage;
  onReplace?: () => void;
  onInsert?: () => void;
}) {
  const isUser = message.role === "user";
  return (
    <div className={cn("flex flex-col", isUser ? "items-end" : "items-start")}>
      <div
        className={cn(
          "max-w-[85%] whitespace-pre-wrap break-words rounded-lg px-2.5 py-1.5 text-[12px] leading-relaxed",
          isUser
            ? "bg-brand-500 text-white"
            : "bg-neutral-100 text-neutral-800 dark:bg-neutral-800 dark:text-neutral-200",
        )}
      >
        {message.content || "…"}
      </div>
      {!isUser && message.content.trim() && (onReplace || onInsert) && (
        <div className="mt-1 flex gap-2">
          {onReplace && (
            <button className="text-[10px] text-neutral-400 hover:text-brand-600" onClick={onReplace}>
              {t("ai.replaceSelection")}
            </button>
          )}
          {onInsert && (
            <button className="text-[10px] text-neutral-400 hover:text-brand-600" onClick={onInsert}>
              {t("ai.insertToCursor")}
            </button>
          )}
        </div>
      )}
    </div>
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
