import { useEffect, useRef, useState } from "react";
import { CornerDownLeft, FileSearch, Search } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useWorkspaceStore } from "@/stores/workspace";
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

/** Ctrl+K 命令面板（项目说明书 5.1 搜索）：输入即搜，标题优先，Enter 跳转 */
export function CommandPalette() {
  const paletteOpen = useWorkspaceStore((s) => s.paletteOpen);
  const closePalette = useWorkspaceStore((s) => s.closePalette);
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const openView = useWorkspaceStore((s) => s.openView);
  const openSearch = useWorkspaceStore((s) => s.openSearch);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchHit[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<number | null>(null);

  // 打开时聚焦并清空上次状态
  useEffect(() => {
    if (paletteOpen) {
      setQuery("");
      setResults([]);
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [paletteOpen]);

  useEffect(() => {
    if (!paletteOpen || !currentWorkspaceId) return;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      const q = query.trim();
      if (!q) {
        setResults([]);
        return;
      }
      searchApi
        .search(currentWorkspaceId, q)
        .then((r) => {
          setResults(r);
          setActive(0);
        })
        .catch((e: unknown) => {
          console.error("search failed", e);
          // 固定 id：连续键击失败只替换同一条 toast，不刷屏
          toast.error(t("error.db", { message: String(e) }), { id: "palette-search-failed" });
        });
    }, 150);
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [query, paletteOpen, currentWorkspaceId]);

  const jump = (hit: SearchHit) => {
    closePalette();
    openView(hit.view_id);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % Math.max(results.length, 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a - 1 + results.length) % Math.max(results.length, 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (results[active]) jump(results[active]);
      else if (query.trim()) openSearch(query.trim());
    }
  };

  return (
    <Dialog open={paletteOpen} onOpenChange={(open) => (open ? undefined : closePalette())}>
      <DialogContent className="top-[15%] w-[560px] max-w-[90vw] p-0" showCloseButton={false}>
        <DialogTitle className="sr-only">{t("search.title")}</DialogTitle>
        <div className="flex items-center gap-2 border-b border-neutral-200 px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-neutral-400" />
          <input
            ref={inputRef}
            className="h-7 flex-1 bg-transparent text-[14px] text-neutral-800 outline-none placeholder:text-neutral-400"
            placeholder={t("search.placeholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <kbd className="shrink-0 rounded border border-neutral-300 bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-500">
            ESC
          </kbd>
        </div>
        <div className="max-h-[380px] min-h-[60px] overflow-y-auto p-1.5">
          {query.trim() === "" ? (
            <div className="flex h-16 items-center justify-center gap-2 text-[13px] text-neutral-400">
              <FileSearch className="h-4 w-4" />
              {t("search.typeHint")}
            </div>
          ) : results.length === 0 ? (
            <div className="flex h-16 items-center justify-center text-[13px] text-neutral-400">
              {t("search.noResults", { query })}
            </div>
          ) : (
            results.map((hit, i) => (
              <button
                key={hit.view_id}
                data-active={i === active}
                className={
                  "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left " +
                  (i === active ? "bg-brand-100" : "hover:bg-neutral-200/60")
                }
                onMouseEnter={() => setActive(i)}
                onClick={() => jump(hit)}
              >
                <span className="flex w-5 shrink-0 items-center justify-center text-neutral-500">{viewIcon(hit)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-neutral-800">
                    {highlightTitle(hit.title, query)}
                  </span>
                  {hit.snippet && (
                    <span
                      className="block truncate text-[12px] text-neutral-500"
                      dangerouslySetInnerHTML={{ __html: hit.snippet }}
                    />
                  )}
                </span>
                <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
              </button>
            ))
          )}
        </div>
        {results.length > 0 && (
          <div className="flex items-center justify-between border-t border-neutral-200 px-4 py-2 text-[11px] text-neutral-400">
            <span>
              ↑↓ {t("search.navigate")} · Enter {t("search.open")}
            </span>
            <button
              className="flex items-center gap-1 text-brand-600 hover:underline"
              onClick={() => {
                if (query.trim()) openSearch(query.trim());
              }}
            >
              <CornerDownLeft className="h-3 w-3" />
              {t("search.allResults")}
            </button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
