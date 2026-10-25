// AI 面板的「历史会话」下拉：搜索、最近/归档分区、改名、归档与删除入口（从 AiPanel.tsx 原样搬出）。
// 除了两件事都自持：关掉面板要改宿主的 showHistory、删会话要过宿主的确认框，所以对外只有 onClose /
// onRequestDelete 两个回调；会话列表与五个 store 动作在这里自己取，搬过来的 JSX 因此一字未改。
import { useState } from "react";
import { Archive, ArchiveRestore, PenLine, Search, Trash2 } from "lucide-react";
import { useAiStore, visibleSessionWindow } from "@/stores/ai";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { filterHistorySessions } from "./ai-utils";
import { RowAction } from "./AiParts";

interface SessionHistoryPopoverProps {
  /** 遮罩、Esc 之外的收起路径与选中会话后收起都走这里（原来内联的 closeHistory） */
  onClose: () => void;
  /** 删除会话先要宿主的确认框：这里只把目标 id 递出去 */
  onRequestDelete: (id: string) => void;
}

export function SessionHistoryPopover({ onClose, onRequestDelete }: SessionHistoryPopoverProps) {
  const sessions = useAiStore((s) => s.sessions);
  const sessionsShown = useAiStore((s) => s.sessionsShown);
  const loadMoreSessions = useAiStore((s) => s.loadMoreSessions);
  const switchSession = useAiStore((s) => s.switchSession);
  const setSessionArchived = useAiStore((s) => s.setSessionArchived);
  const renameSession = useAiStore((s) => s.renameSession);

  // 历史会话面板：搜索词 + 是否在看归档区 + 正在改名的那一行
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyArchived, setHistoryArchived] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  // 历史列表只在面板展开时算：正文逐条比对不便宜，没必要跟着流式增量每帧跑一遍。
  // 先取显示窗口（归档全留 + 最近 MAX_SESSIONS×n 条普通会话），再按分区/关键词筛。
  // 原来这四行外面套着 `showHistory ? … : []`：组件现在只在面板展开时挂载，守卫恒真，摘掉算的是同一份数据。
  const windowedSessions = visibleSessionWindow(sessions, sessionsShown);
  const hiddenNormalCount = sessions.length - windowedSessions.length;
  const archivedCount = sessions.filter((x) => x.archived).length;
  const historyList = filterHistorySessions(windowedSessions, historyArchived, historyQuery);

  const closeHistory = () => {
    onClose();
    setRenamingId(null);
  };

  const commitRename = (id: string) => {
    renameSession(id, renameDraft);
    setRenamingId(null);
  };

  return (
    <>
      <button className="fixed inset-0 z-20 cursor-default" aria-label={t("ai.closeHistory")} onClick={closeHistory} />
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
                historyArchived === flag && "bg-neutral-100 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200",
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
                    {sess.pageTitle && <span className="ml-1 text-[10px] text-neutral-400">· {sess.pageTitle}</span>}
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
                      icon={sess.archived ? <ArchiveRestore className="h-3 w-3" /> : <Archive className="h-3 w-3" />}
                      label={sess.archived ? t("ai.unarchiveSession") : t("ai.archiveSession")}
                      onClick={() => setSessionArchived(sess.id, !sess.archived)}
                    />
                    <RowAction
                      icon={<Trash2 className="h-3 w-3" />}
                      label={t("ai.deleteSession")}
                      danger
                      onClick={() => onRequestDelete(sess.id)}
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
  );
}
