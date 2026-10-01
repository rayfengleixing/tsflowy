import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Clock, CornerDownLeft, FilePlus, FileSearch, History, Search, Settings, SunMoon, Trash2, X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { HighlightedTitle } from "@/components/highlighted-title";
import { useWorkspaceStore } from "@/stores/workspace";
import { useDatabaseStore } from "@/stores/database";
import { useSettingsStore } from "@/stores/settings";
import { searchApi, titleTier, TIER_BODY_ONLY, type SearchHit } from "@/lib/search";
import { clearSearchHistory, loadSearchHistory, pushSearchHistory } from "@/lib/search-history";
import { viewApi } from "@/lib/db";
import { flattenTree } from "@/lib/tree";
import { viewIcon } from "@/components/view-icon";
import type { View } from "@/types/models";
import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import { toast } from "sonner";

interface PaletteAction {
  id: string;
  label: string;
  icon: ReactNode;
  run: () => void;
}

/** 面板里的一行：动作 / 历史查询 / 最近访问 / 搜索命中，↑↓ 走的就是这条扁平序列 */
type Row =
  | { kind: "action"; action: PaletteAction }
  | { kind: "query"; text: string }
  | { kind: "recent"; view: View }
  | { kind: "hit"; hit: SearchHit };

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
  const [history, setHistory] = useState<string[]>([]);
  const [recent, setRecent] = useState<View[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<number | null>(null);

  const actions = useMemo<PaletteAction[]>(
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
    return q ? actions.filter((a) => titleTier(a.label, q) < TIER_BODY_ONLY) : actions;
  }, [actions, query]);

  const trimmed = query.trim();

  // 动作在前、搜索结果在后；空查询时补上「最近搜索 / 最近访问」——启动器不再是一张白纸
  const rows = useMemo<Row[]>(() => {
    const actionRows: Row[] = actionMatches.map((action) => ({ kind: "action", action }));
    if (trimmed) return [...actionRows, ...results.map((hit): Row => ({ kind: "hit", hit }))];
    return [
      ...actionRows,
      ...history.map((text): Row => ({ kind: "query", text })),
      ...recent.map((view): Row => ({ kind: "recent", view })),
    ];
  }, [actionMatches, results, history, recent, trimmed]);

  const runRow = (row: Row) => {
    switch (row.kind) {
      case "action":
        closePalette();
        row.action.run();
        break;
      case "query":
        setQuery(row.text);
        inputRef.current?.focus();
        break;
      case "recent":
        closePalette();
        openView(row.view.id);
        break;
      case "hit":
        pushSearchHistory(trimmed);
        closePalette();
        if (row.hit.row_id) useDatabaseStore.getState().setFocusRow(row.hit.row_id);
        openView(row.hit.view_id);
        break;
    }
  };

  // 打开时聚焦、清空上次状态，并把历史与最近访问取回来
  useEffect(() => {
    if (!paletteOpen) return;
    setQuery("");
    setResults([]);
    setActive(0);
    setHistory(loadSearchHistory());
    setTimeout(() => inputRef.current?.focus(), 30);
    if (!currentWorkspaceId) {
      setRecent([]);
      return;
    }
    viewApi
      .listRecent(currentWorkspaceId, 5)
      .then(setRecent)
      .catch(logger.catch("palette.recent", "list recent failed"));
  }, [paletteOpen, currentWorkspaceId]);

  useEffect(() => {
    if (!paletteOpen || !currentWorkspaceId) return;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      const q = query.trim();
      if (!q) {
        setResults([]);
        return;
      }
      // 本地补一份标题/拼音首字母命中：FTS 只按字面匹配，输入 "bj" 找不到「笔记」
      const views = flattenTree(useWorkspaceStore.getState().tree);
      searchApi
        .search(currentWorkspaceId, q, views)
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

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % Math.max(rows.length, 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a - 1 + rows.length) % Math.max(rows.length, 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (rows.length > 0) runRow(rows[Math.min(active, rows.length - 1)]);
      else if (trimmed) {
        pushSearchHistory(trimmed);
        openSearch(trimmed);
      }
    }
  };

  // 按 kind 切段渲染（同类行连在一起才归为一段），同时保留每行在扁平序列里的下标
  const sections = useMemo(() => {
    const titleOf: Record<Row["kind"], string> = {
      action: t("palette.actions.title"),
      query: t("search.history"),
      recent: t("search.recent"),
      hit: t("search.results"),
    };
    interface Section {
      kind: Row["kind"];
      title: string;
      items: { row: Row; index: number }[];
    }
    const out: Section[] = [];
    let last: Section | null = null;
    rows.forEach((row, index) => {
      if (last?.kind === row.kind) {
        last.items.push({ row, index });
        return;
      }
      last = { kind: row.kind, title: titleOf[row.kind], items: [{ row, index }] };
      out.push(last);
    });
    return out;
  }, [rows]);

  const rowClass = (index: number) =>
    "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left " +
    (index === active ? "bg-brand-100" : "hover:bg-neutral-200/60");

  return (
    <Dialog open={paletteOpen} onOpenChange={(open) => (open ? undefined : closePalette())}>
      {/* 顶部锚定 + 视口高度约束：基类是居中(-translate-y-1/2)，面板变高会把输入框顶出窗口 */}
      <DialogContent
        className="top-[12%] flex max-h-[76vh] w-[560px] max-w-[90vw] translate-y-0 flex-col gap-0 p-0"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">{t("search.title")}</DialogTitle>
        <div className="flex shrink-0 items-center gap-2 border-b border-neutral-200 px-4 py-3">
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
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {sections.map((section) => (
            <div key={section.title}>
              <div className="flex items-center justify-between px-2.5 py-1">
                <p className="text-[11px] text-neutral-400">{section.title}</p>
                {section.kind === "query" && (
                  <button
                    className="flex items-center gap-1 rounded px-1 text-[11px] text-neutral-400 hover:text-neutral-600"
                    onClick={() => {
                      clearSearchHistory();
                      setHistory([]);
                    }}
                  >
                    <X className="h-3 w-3" />
                    {t("search.clearHistory")}
                  </button>
                )}
              </div>
              {section.items.map(({ row, index }) => {
                if (row.kind === "action") {
                  return (
                    <button
                      key={row.action.id}
                      data-testid={"palette-action-" + row.action.id}
                      data-active={index === active}
                      className={rowClass(index)}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => runRow(row)}
                    >
                      <span className="flex w-5 shrink-0 items-center justify-center text-neutral-500">
                        {row.action.icon}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[13px] text-neutral-800">{row.action.label}</span>
                    </button>
                  );
                }
                if (row.kind === "query") {
                  return (
                    <button
                      key={"q-" + row.text}
                      data-active={index === active}
                      className={rowClass(index)}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => runRow(row)}
                    >
                      <span className="flex w-5 shrink-0 items-center justify-center text-neutral-400">
                        <History className="h-3.5 w-3.5" />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[13px] text-neutral-700">{row.text}</span>
                    </button>
                  );
                }
                if (row.kind === "recent") {
                  return (
                    <button
                      key={"r-" + row.view.id}
                      data-active={index === active}
                      className={rowClass(index)}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => runRow(row)}
                    >
                      <span className="flex w-5 shrink-0 items-center justify-center text-neutral-500">
                        {viewIcon(row.view)}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[13px] text-neutral-800">{row.view.name}</span>
                      <Clock className="h-3.5 w-3.5 shrink-0 text-neutral-300" />
                    </button>
                  );
                }
                return (
                  <button
                    key={row.hit.view_id}
                    data-active={index === active}
                    className={rowClass(index)}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => runRow(row)}
                  >
                    <span className="flex w-5 shrink-0 items-center justify-center text-neutral-500">
                      {viewIcon(row.hit)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-neutral-800">
                        <HighlightedTitle title={row.hit.title} query={trimmed} />
                      </span>
                      {row.hit.snippet && (
                        <span
                          className="block truncate text-[12px] text-neutral-500"
                          dangerouslySetInnerHTML={{ __html: row.hit.snippet }}
                        />
                      )}
                    </span>
                    <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
                  </button>
                );
              })}
            </div>
          ))}
          {trimmed !== "" && results.length === 0 && (
            <div className="flex h-16 items-center justify-center gap-2 text-[13px] text-neutral-400">
              {actionMatches.length === 0 && <FileSearch className="h-4 w-4" />}
              {t("search.noResults", { query })}
            </div>
          )}
        </div>
        {(results.length > 0 || trimmed === "") && (
          <div className="flex items-center justify-between border-t border-neutral-200 px-4 py-2 text-[11px] text-neutral-400">
            <span>
              {trimmed === "" ? t("search.typeHint") : `↑↓ ${t("search.navigate")} · Enter ${t("search.open")}`}
            </span>
            {results.length > 0 && (
              <button
                className="flex items-center gap-1 text-brand-600 hover:underline"
                onClick={() => {
                  pushSearchHistory(trimmed);
                  openSearch(trimmed);
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