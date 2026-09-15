import { useEffect, useState } from "react";
import { ArrowLeft, FileSearch } from "lucide-react";
import { useWorkspaceStore } from "@/stores/workspace";
import { useDatabaseStore } from "@/stores/database";
import { searchApi, type SearchHit } from "@/lib/search";
import { viewIcon } from "@/components/view-icon";
import { t } from "@/lib/i18n";
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

/** 搜索结果页（项目说明书 10-M3：可跳转） */
export function SearchResultsPage() {
  const searchQuery = useWorkspaceStore((s) => s.searchQuery);
  const setRoute = useWorkspaceStore((s) => s.setRoute);
  const openView = useWorkspaceStore((s) => s.openView);
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const [results, setResults] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(true);

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
        console.error("search failed", e);
        toast.error(t("error.db", { message: String(e) }));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [searchQuery, currentWorkspaceId]);

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
        <h1 className="text-[15px] font-medium text-neutral-800">
          {t("search.resultsFor")} <span className="text-brand-600">「{searchQuery}」</span>
        </h1>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[720px] px-6 py-4">
          {loading ? (
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
                  onClick={() => {
                    // 单元格命中：先记下命中行，视图挂载后据此滚动定位
                    if (hit.row_id) useDatabaseStore.getState().setFocusRow(hit.row_id);
                    openView(hit.view_id);
                    setRoute("workspace");
                  }}
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
