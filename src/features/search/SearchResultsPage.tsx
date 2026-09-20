import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Clock, FileSearch } from "lucide-react";
import { useWorkspaceStore } from "@/stores/workspace";
import { useDatabaseStore } from "@/stores/database";
import { searchApi, type SearchHit } from "@/lib/search";
import { viewApi } from "@/lib/db";
import type { View } from "@/types/models";
import { viewIcon } from "@/components/view-icon";
import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import { toast } from "sonner";

function highlightTitle(title: string, query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return title;
  const lower = title.toLowerCase();
  const parts: { text: string; hit: boolean }[] = [];
  let i = 0;
  while (i < title.length) {
    const idx = lower.indexOf(q, i);
    if (idx === -1) {
      parts.push({ text: title.slice(i), hit: false });
      break;
    }
    if (idx > i) parts.push({ text: title.slice(i, idx), hit: false });
    parts.push({ text: title.slice(idx, idx + q.length), hit: true });
    i = idx + q.length;
  }
  return parts.map((p, k) =>
    p.hit ? (
      <mark key={k} className="rounded-sm bg-brand-100 text-brand-600">
        {p.text}
      </mark>
    ) : (
      <span key={k}>{p.text}</span>
    ),
  );
}

/** 搜索结果页（项目说明书 10-M3：可跳转）。查询词空时显示最近访问，Ctrl+Shift+F 落进来即可输入。 */
export function SearchResultsPage() {
  const searchQuery = useWorkspaceStore((s) => s.searchQuery);
  const openSearch = useWorkspaceStore((s) => s.openSearch);
  const setRoute = useWorkspaceStore((s) => s.setRoute);
  const openView = useWorkspaceStore((s) => s.openView);
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const [input, setInput] = useState(searchQuery);
  const [results, setResults] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [recent, setRecent] = useState<View[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<number | null>(null);
  // 最后一次由本页推给 store 的查询：store 里的值变了但与此不同 = 外部（命令面板/快捷键）改动
  const pushedRef = useRef(searchQuery);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 输入防抖 150ms（与命令面板一致）：每键击都搜一次会让短查询的 LIKE 全表兜底连发
  useEffect(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      const q = input.trim();
      if (q === pushedRef.current) return;
      pushedRef.current = q;
      openSearch(q);
    }, 150);
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [input, openSearch]);

  useEffect(() => {
    if (searchQuery === pushedRef.current) return;
    pushedRef.current = searchQuery;
    setInput(searchQuery);
  }, [searchQuery]);

  useEffect(() => {
    let alive = true;
    const q = searchQuery.trim();
    if (!q || !currentWorkspaceId) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    searchApi
      .search(currentWorkspaceId, q)
      .then((r) => {
        if (alive) setResults(r);
      })
      .catch((e: unknown) => {
        logger.error("search.page", e);
        toast.error(t("error.db", { message: String(e) }));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [searchQuery, currentWorkspaceId]);

  // 最近访问（Rust list_recent 按 visited_at 倒序）：空查询时的落点，替代空白页
  useEffect(() => {
    if (!currentWorkspaceId) return;
    let alive = true;
    viewApi
      .listRecent(currentWorkspaceId, 12)
      .then((rows) => {
        if (alive) setRecent(rows);
      })
      .catch((e: unknown) => logger.error("search.recent", e));
    return () => {
      alive = false;
    };
  }, [currentWorkspaceId, searchQuery]);

  const openHit = (hit: { view_id: string; row_id?: string | null }) => {
    // 单元格命中：先记下命中行，视图挂载后据此滚动定位
    if (hit.row_id) useDatabaseStore.getState().setFocusRow(hit.row_id);
    openView(hit.view_id);
    setRoute("workspace");
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-neutral-200 px-4">
        <button
          className="flex h-7 w-7 items-center justify-center rounded text-neutral-500 hover:bg-neutral-200"
          title={t("search.back")}
          onClick={() => setRoute("workspace")}
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <FileSearch className="h-4 w-4 shrink-0 text-neutral-400" />
        <input
          ref={inputRef}
          className="h-7 min-w-0 flex-1 bg-transparent text-[14px] text-neutral-800 outline-none placeholder:text-neutral-400 dark:text-neutral-100"
          placeholder={t("search.placeholder")}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setInput("");
              openSearch("");
            }
          }}
        />
        {searchQuery.trim() && (
          <span className="shrink-0 text-[12px] text-neutral-400">
            {t("search.found", { count: String(results.length) })}
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[720px] px-6 py-4">
          {!searchQuery.trim() ? (
            <div className="flex flex-col gap-1">
              <p className="mb-1 flex items-center gap-1.5 text-[12px] text-neutral-500">
                <Clock className="h-3.5 w-3.5" />
                {t("search.recent")}
              </p>
              {recent.length === 0 ? (
                <p className="py-8 text-center text-[13px] text-neutral-400">{t("sidebar.recent.empty")}</p>
              ) : (
                recent.map((v) => (
                  <button
                    key={v.id}
                    data-testid="recent-hit"
                    className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-left hover:bg-neutral-200/60"
                    onClick={() => openHit({ view_id: v.id })}
                  >
                    <span className="flex w-5 shrink-0 items-center justify-center text-neutral-500">
                      {viewIcon(v)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13px] text-neutral-800 dark:text-neutral-100">
                      {v.name}
                    </span>
                  </button>
                ))
              )}
            </div>
          ) : loading ? (
            <p className="py-10 text-center text-[13px] text-neutral-400">{t("search.loading")}</p>
          ) : results.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-16 text-neutral-400">
              <FileSearch className="h-8 w-8" />
              <p className="text-[13px]">{t("search.noResults", { query: searchQuery })}</p>
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              <p className="mb-1 text-[12px] text-neutral-500">
                {t("search.found", { count: String(results.length) })}
              </p>
              {results.map((hit) => (
                <button
                  key={hit.view_id}
                  className="group flex items-start gap-2.5 rounded-lg px-3 py-2.5 text-left hover:bg-neutral-200/60"
                  onClick={() => openHit(hit)}
                >
                  <span className="mt-0.5 flex w-5 shrink-0 items-center justify-center text-neutral-500">
                    {viewIcon(hit)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-medium text-neutral-800">
                      {highlightTitle(hit.title, searchQuery)}
                    </span>
                    {hit.snippet && (
                      <span
                        className="mt-0.5 block truncate text-[12px] text-neutral-500"
                        dangerouslySetInnerHTML={{ __html: hit.snippet }}
                      />
                    )}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
