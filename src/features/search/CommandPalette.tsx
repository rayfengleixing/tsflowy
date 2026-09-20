import { useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, FilePlus, FileSearch, Search, Settings, SunMoon, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useWorkspaceStore } from "@/stores/workspace";
import { useDatabaseStore } from "@/stores/database";
import { useSettingsStore } from "@/stores/settings";
import { searchApi, type SearchHit } from "@/lib/search";
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

/** Ctrl+K 命令面板（项目说明书 5.1 搜索）：快捷动作 + 输入即搜，标题优先，Enter 跳转 */
export function CommandPalette() {
  const paletteOpen = useWorkspaceStore((s) => s.paletteOpen);
  const closePalette = useWorkspaceStore((s) => s.closePalette);
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const openView = useWorkspaceStore((s) => s.openView);
  const openSearch = useWorkspaceStore((s) => s.openSearch);
  const createView = useWorkspaceStore((s) => s.createView);
  const setRoute = useWorkspaceStore((s) => s.setRoute);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchHit[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<number | null>(null);

  const actions = useMemo(
    () => [
      {
        id: "newPage",
        label: t("palette.action.newPage"),
        icon: <FilePlus className="h-4 w-4" />,
        run: () => {
          createView({ parentId: null, layout: "document" }).catch((e: unknown) => {
            logger.error("palette.newPage", e);
            toast.error(t("error.db", { message: String(e) }));
          });
        },
      },
      {
        id: "toggleTheme",
        label: t("palette.action.toggleTheme"),
        icon: <SunMoon className="h-4 w-4" />,
        run: () => {
          const s = useSettingsStore.getState();
          s.setTheme(s.theme === "dark" ? "light" : "dark");
        },
      },
      {
        id: "openSettings",
        label: t("palette.action.openSettings"),
        icon: <Settings className="h-4 w-4" />,
        run: () => setRoute("settings"),
      },
      {
        id: "openTrash",
        label: t("palette.action.openTrash"),
        icon: <Trash2 className="h-4 w-4" />,
        run: () => setRoute("trash"),
      },
    ],
    [createView, setRoute],
  );

  // 输入即过滤动作；空查询时动作就是主内容（面板即启动器）
  const actionMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? actions.filter((a) => a.label.toLowerCase().includes(q)) : actions;
  }, [actions, query]);

  // 动作在前、搜索结果在后，↑↓/Enter 只认这一条扁平序列
  const itemCount = actionMatches.length + results.length;
  const runItem = (index: number) => {
    if (index < actionMatches.length) {
      const action = actionMatches[index];
      closePalette();
      action.run();
      return;
    }
    // find 保证取到的是 SearchHit | undefined：越界（动作数变化后 active 未及归零）时不误跳
    const hit = results.find((_, i) => i === index - actionMatches.length);
    if (hit) jump(hit);
  };

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
          logger.error("search failed", e);
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
    // 单元格命中：先记下命中行，视图挂载后据此滚动定位
    if (hit.row_id) useDatabaseStore.getState().setFocusRow(hit.row_id);
    openView(hit.view_id);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % Math.max(itemCount, 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a - 1 + itemCount) % Math.max(itemCount, 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (itemCount > 0) runItem(Math.min(active, itemCount - 1));
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
          {actionMatches.length > 0 && (
            <>
              <p className="px-2.5 py-1 text-[11px] text-neutral-400">{t("palette.actions.title")}</p>
              {actionMatches.map((a, i) => (
                <button
                  key={a.id}
                  data-testid={"palette-action-" + a.id}
                  data-active={i === active}
                  className={
                    "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left " +
                    (i === active ? "bg-brand-100" : "hover:bg-neutral-200/60")
                  }
                  onMouseEnter={() => setActive(i)}
                  onClick={() => {
                    closePalette();
                    a.run();
                  }}
                >
                  <span className="flex w-5 shrink-0 items-center justify-center text-neutral-500">{a.icon}</span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-neutral-800">{a.label}</span>
                </button>
              ))}
            </>
          )}
          {query.trim() !== "" &&
            (results.length === 0 ? (
              <div className="flex h-16 items-center justify-center gap-2 text-[13px] text-neutral-400">
                {actionMatches.length === 0 && <FileSearch className="h-4 w-4" />}
                {t("search.noResults", { query })}
              </div>
            ) : (
              results.map((hit, i) => {
                const index = actionMatches.length + i;
                return (
                  <button
                    key={hit.view_id}
                    data-active={index === active}
                    className={
                      "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left " +
                      (index === active ? "bg-brand-100" : "hover:bg-neutral-200/60")
                    }
                    onMouseEnter={() => setActive(index)}
                    onClick={() => jump(hit)}
                  >
                    <span className="flex w-5 shrink-0 items-center justify-center text-neutral-500">
                      {viewIcon(hit)}
                    </span>
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
                );
              })
            ))}
        </div>
        {(results.length > 0 || query.trim() === "") && (
          <div className="flex items-center justify-between border-t border-neutral-200 px-4 py-2 text-[11px] text-neutral-400">
            <span>
              {query.trim() === "" ? t("search.typeHint") : `↑↓ ${t("search.navigate")} · Enter ${t("search.open")}`}
            </span>
            {results.length > 0 && (
              <button
                className="flex items-center gap-1 text-brand-600 hover:underline"
                onClick={() => {
                  if (query.trim()) openSearch(query.trim());
                }}
              >
                <CornerDownLeft className="h-3 w-3" />
                {t("search.allResults")}
              </button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
