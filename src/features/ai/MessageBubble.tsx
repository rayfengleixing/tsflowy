// AiPanel 里一条消息的渲染：正文气泡 + AI 动作卡片（从 AiPanel.tsx 原样搬出，无逻辑/样式改动）
import { memo } from "react";
import {
  Check,
  CornerDownLeft,
  Copy,
  Download,
  FileText,
  GitBranch,
  PenLine,
  RefreshCw,
  Replace,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  TriangleAlert,
} from "lucide-react";
import { type AiActionRecord, type AiMessage } from "@/stores/ai";
import { t, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ImageThumb } from "./AiParts";
import { Markdown } from "./Markdown";

/**
 * 长回答流式刷新时只有最后一条内容在变，历史消息不必跟着重解析 Markdown。
 * 这里对渲染组件做记忆化，props（text）不变就跳过。
 */
const MarkdownMemo = memo(Markdown);

/** 动作类型名：出现在卡片的状态文案里（「待确认：AI 建议新建页面」） */
const TOOL_LABEL: Record<AiActionRecord["tool"], MessageKey> = {
  apply_edit: "ai.toolNameApplyEdit",
  create_page: "ai.toolNameCreatePage",
  set_page_title: "ai.toolNameSetPageTitle",
  add_database_row: "ai.toolNameAddDatabaseRow",
  update_database_row: "ai.toolNameUpdateDatabaseRow",
  delete_database_row: "ai.toolNameDeleteDatabaseRow",
  invalid: "ai.toolNameInvalid",
};

function actionStatusText(a: AiActionRecord): string {
  const name = t(TOOL_LABEL[a.tool]);
  const isEdit = a.tool === "apply_edit";
  switch (a.state) {
    case "malformed":
      return t("ai.editMalformed");
    case "pending":
      return isEdit ? t("ai.editPending") : t("ai.actionPending", { name });
    case "rejected":
      return isEdit ? t("ai.editRejected") : t("ai.actionRejected", { name });
    case "unavailable":
      return isEdit ? t("ai.editNotApplied") : t("ai.actionUnavailable", { name });
    case "applied":
      if (a.undone) return t("ai.editUndone");
      return isEdit ? t("ai.editApplied") : t("ai.actionApplied", { name });
  }
}

/** 历史数据兜底：旧版本曾把未翻译的裸 i18n key 当失败原因持久化进 detail，显示前翻译，查不到原样 */
const LEGACY_DETAIL_KEYS = new Map<string, MessageKey>([
  ["ai.locateHeadingNotFound", "ai.locateHeadingNotFound"],
  ["ai.locateTextNotFound", "ai.locateTextNotFound"],
  ["ai.locateProtectedHeading", "ai.locateProtectedHeading"],
  ["ai.locateBlockedByLock", "ai.locateBlockedByLock"],
]);

function detailText(detail: string): string {
  const key = LEGACY_DETAIL_KEYS.get(detail);
  return key ? t(key) : detail;
}

/** 值得弹 diff 预览的动作：改文档要看改前改后，建页要看正文；改标题/加行只有一句话说明 */
function canShowDiff(a: AiActionRecord): boolean {
  if (a.state === "malformed" || a.state === "rejected") return false;
  if (a.tool === "apply_edit") return a.content.trim().length > 0 || a.before.trim().length > 0;
  return a.tool === "create_page" && a.content.trim().length > 0;
}

/** 传给 MessageBubble 的稳定操作集：引用不变才能让 memo 生效（见 bubbleApi） */
export interface BubbleApi {
  copy: (content: string) => void;
  regenerate: (id: string) => void;
  edit: (message: AiMessage) => void;
  savePage: (id: string) => void;
  exportMsg: (id: string) => void;
  branch: (id: string) => void;
  rate: (id: string, rating: "up" | "down") => void;
  writeBack: (text: string, mode: "replace" | "insert") => void;
  undo: (msgId: string, index: number) => void;
  apply: (msgId: string, index: number) => void;
  reject: (msgId: string, index: number) => void;
  viewDiff: (msgId: string, index: number, record: AiActionRecord) => void;
}

/** memo：消息对象与 api 引用不变即跳过重渲——流式增量只重渲染最后一条 */
export const MessageBubble = memo(function MessageBubble({
  message,
  busy = false,
  api,
}: {
  message: AiMessage;
  /** 流式进行中：消息级操作会改写消息列表，此时一律禁用 */
  busy?: boolean;
  api: BubbleApi;
}) {
  const isUser = message.role === "user";
  const actions = message.actions ?? [];
  // 正文为空、内容被 summary 兜底时不再渲染气泡，避免与下方结果卡片重复
  const bubbleText = message.content === actions[0]?.summary ? "" : message.content;
  return (
    <div className={cn("flex flex-col", isUser ? "items-end" : "items-start")}>
      {/* 提问附带的图片：正文之上，右对齐贴着气泡 */}
      {isUser && message.images && message.images.length > 0 && (
        <div className="mb-1 flex max-w-[85%] flex-wrap justify-end gap-1.5">
          {message.images.map((img) => (
            <ImageThumb key={img.path} path={img.path} name={img.name} />
          ))}
        </div>
      )}
      {(bubbleText.trim() || (actions.length === 0 && !message.images?.length)) &&
        (isUser ? (
          <div className="max-w-[85%] rounded-lg bg-brand-500 px-2.5 py-1.5 text-[12px] leading-relaxed whitespace-pre-wrap break-words text-white">
            {bubbleText || "…"}
          </div>
        ) : (
          // 助手回复走 Markdown 渲染（GFM 表格/代码块/链接），AI 输出不含原始 HTML，无注入风险
          <MarkdownMemo
            text={bubbleText || "…"}
            className="max-w-[85%] rounded-lg bg-neutral-100 px-2.5 py-1.5 text-neutral-800 dark:bg-neutral-800 dark:text-neutral-200"
          />
        ))}
      {/* AI 下发的每个动作各一张卡片：待确认 / 已执行 / 未执行 / 已忽略 / 指令有误 */}
      {actions.map((a, i) => (
        <div key={i} className="mt-1.5 max-w-[85%]">
          <div
            className={cn(
              "flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px]",
              a.state === "applied" && !a.undone
                ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
                : a.state === "pending"
                  ? "border-brand-400 bg-brand-50 text-brand-700 dark:border-brand-500 dark:bg-neutral-800 dark:text-neutral-200"
                  : "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
            )}
          >
            {a.state === "applied" && !a.undone ? (
              <Check className="h-3 w-3 shrink-0" />
            ) : a.state === "pending" ? (
              <Sparkles className="h-3 w-3 shrink-0" />
            ) : (
              <TriangleAlert className="h-3 w-3 shrink-0" />
            )}
            <span className="min-w-0 flex-1 truncate">
              {actionStatusText(a)}
              {a.summary && a.state !== "malformed" ? `：${a.summary}` : ""}
              {/* 执行结果或失败原因（跨页写动作、表行写入等只有说明可展示） */}
              {a.detail ? `（${detailText(a.detail)}）` : ""}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {canShowDiff(a) && <MiniButton label={t("ai.viewDiff")} onClick={() => api.viewDiff(message.id, i, a)} />}
            {a.state === "pending" && <MiniButton label={t("ai.applyEdit")} onClick={() => api.apply(message.id, i)} />}
            {a.state === "pending" && (
              <MiniButton label={t("ai.rejectEdit")} onClick={() => api.reject(message.id, i)} />
            )}
            {/* revert = 编辑器 undo 栈快照（只在当前实例内有效）；undo = 随会话落库的逆操作计划，重启后仍可撤 */}
            {a.state === "applied" && !a.undone && (a.revert ?? a.undo) && (
              <MiniButton label={t("ai.undoEdit")} onClick={() => api.undo(message.id, i)} />
            )}
          </div>
        </div>
      ))}
      {!isUser && bubbleText.trim() && (
        <div className="mt-1.5 flex gap-1.5">
          <button
            className="flex items-center gap-1 rounded-md border border-neutral-200 px-1.5 py-0.5 text-[11px] text-neutral-600 hover:border-brand-400 hover:bg-brand-50 hover:text-brand-700 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
            title={t("ai.replaceSelection")}
            onClick={() => api.writeBack(message.content, "replace")}
          >
            <Replace className="h-3 w-3" />
            {t("ai.replaceSelection")}
          </button>
          <button
            className="flex items-center gap-1 rounded-md border border-neutral-200 px-1.5 py-0.5 text-[11px] text-neutral-600 hover:border-brand-400 hover:bg-brand-50 hover:text-brand-700 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
            title={t("ai.insertToCursor")}
            onClick={() => api.writeBack(message.content, "insert")}
          >
            <CornerDownLeft className="h-3 w-3" />
            {t("ai.insertToCursor")}
          </button>
        </div>
      )}
      {/* 消息级操作：重新生成 / 改这条提问 / 复制 / 存为页面 / 导出 / 分支（按角色取舍） */}
      {!busy && message.content.trim() && (
        <div className="mt-1 flex gap-0.5">
          {!isUser && (
            <IconAction
              icon={<RefreshCw className="h-3 w-3" />}
              label={t("ai.msgRegenerate")}
              onClick={() => api.regenerate(message.id)}
            />
          )}
          {isUser && (
            <IconAction
              icon={<PenLine className="h-3 w-3" />}
              label={t("ai.msgEdit")}
              onClick={() => api.edit(message)}
            />
          )}
          <IconAction
            icon={<Copy className="h-3 w-3" />}
            label={t("ai.msgCopy")}
            onClick={() => api.copy(message.content)}
          />
          {!isUser && (
            <IconAction
              icon={<FileText className="h-3 w-3" />}
              label={t("ai.msgSavePage")}
              onClick={() => api.savePage(message.id)}
            />
          )}
          {!isUser && (
            <IconAction
              icon={<Download className="h-3 w-3" />}
              label={t("ai.msgExport")}
              onClick={() => api.exportMsg(message.id)}
            />
          )}
          <IconAction
            icon={<GitBranch className="h-3 w-3" />}
            label={t("ai.msgBranch")}
            onClick={() => api.branch(message.id)}
          />
          {!isUser && (
            <>
              <IconAction
                icon={<ThumbsUp className="h-3 w-3" />}
                label={t("ai.msgRateUp")}
                active={message.rating === "up"}
                onClick={() => api.rate(message.id, "up")}
              />
              <IconAction
                icon={<ThumbsDown className="h-3 w-3" />}
                label={t("ai.msgRateDown")}
                active={message.rating === "down"}
                onClick={() => api.rate(message.id, "down")}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
});

/** 气泡下方的一排图标操作（重新生成 / 改提问 / 复制 / 存为页面 / 导出 / 分支） */
function IconAction({
  icon,
  label,
  onClick,
  active = false,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  /** 已处于该状态（如已点赞过）：常驻高亮，不再只在 hover 时显色 */
  active?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        "flex h-5 w-5 items-center justify-center rounded text-neutral-400 hover:bg-neutral-200 hover:text-neutral-600 dark:hover:bg-neutral-700 dark:hover:text-neutral-300",
        active && "text-brand-600 dark:text-brand-400",
      )}
      onClick={onClick}
    >
      {icon}
    </button>
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
