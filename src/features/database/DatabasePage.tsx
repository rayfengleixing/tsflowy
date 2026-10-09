import { useEffect, useRef, useState } from "react";
import { viewApi } from "@/lib/db";
import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import { patchViewConfig, readViewConfig } from "@/lib/view-config";
import { toast } from "sonner";
import { createDatabaseStore } from "@/stores/database";
import { DatabaseStoreProvider } from "@/stores/database-context";
import { BoardView } from "./BoardView";
import { CalendarView } from "./CalendarView";
import { GridView } from "./GridView";
import { TimelineView } from "./TimelineView";
import { ViewChips } from "./ViewChips";
import type { View } from "@/types/models";

/**
 * 数据库页（多视图，阶段 2）：页面 = 宿主 view，页内可挂多个派生 view（grid/board/calendar）。
 *
 * 字段/行/单元格只属于宿主，派生 view 仅携带自己的显示配置（筛选/排序/分组字段），
 * 所以这里同时向下传两份 view：
 * - view：当前视图，作为 store 数据键与该视图配置的载体
 * - source：宿主页面，标题、重命名与行详情归属都挂在它上面
 */
export function DatabasePage({ view }: { view: View }) {
  const [rows, setRows] = useState<View[]>([view]);
  const [activeId, setActiveId] = useState(view.id);
  // 每个数据库页（含并排对照的每一栏）持有一份独立的数据 store：
  // 两栏同时打开不同数据库时各读各的字段/行/单元格，互不覆盖。
  const [store] = useState(createDatabaseStore);

  // view 是树快照（改名等会换新对象），但重取派生视图列表只应在换页面时发生：
  // 用 ref 承接最新快照，effect 依赖仍只写 view.id
  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(() => {
    let alive = true;
    const v = viewRef.current;
    setRows([v]);
    setActiveId(v.id);
    viewApi
      .listForSource(v.id)
      .then((list) => {
        if (!alive) return;
        setRows(list.length > 0 ? list : [v]);
        // 上次停留的视图可能已被删除：校验存在后再恢复，否则回落到宿主
        const saved = readViewConfig(v).activeViewId;
        if (saved && list.some((x) => x.id === saved)) setActiveId(saved);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        logger.error("database-page.list-views", e);
        toast.error(t("error.db", { message: String(e) }));
      });
    return () => {
      alive = false;
    };
  }, [view.id]);

  // 宿主那一行以树快照为准：侧边栏改名后标签立刻跟上（重取只在换页时发生）
  const views = rows.map((v) => (v.id === view.id ? view : v));
  const active = views.find((v) => v.id === activeId) ?? views[0];

  const select = (id: string) => {
    setActiveId(id);
    patchViewConfig(view, { activeViewId: id });
  };

  const grid = views.find((v) => v.layout === "grid");
  const tabs = (
    <ViewChips
      source={view}
      views={views}
      activeId={active.id}
      onSelect={select}
      onCreated={(created) => {
        setRows((prev) => [...prev, created]);
        select(created.id);
      }}
      onRenamed={(id, name) => setRows((prev) => prev.map((v) => (v.id === id ? { ...v, name } : v)))}
      onDeleted={(id) => {
        setRows((prev) => prev.filter((v) => v.id !== id));
        if (id === active.id) select(view.id);
      }}
    />
  );

  if (active.layout === "board") {
    return (
      <DatabaseStoreProvider value={store}>
        <BoardView
          key={active.id}
          view={active}
          source={view}
          tabs={tabs}
          onGoGrid={grid ? () => select(grid.id) : undefined}
        />
      </DatabaseStoreProvider>
    );
  }
  if (active.layout === "calendar") {
    return (
      <DatabaseStoreProvider value={store}>
        <CalendarView
          key={active.id}
          view={active}
          source={view}
          tabs={tabs}
          onGoGrid={grid ? () => select(grid.id) : undefined}
        />
      </DatabaseStoreProvider>
    );
  }
  if (active.layout === "timeline") {
    return (
      <DatabaseStoreProvider value={store}>
        <TimelineView
          key={active.id}
          view={active}
          source={view}
          tabs={tabs}
          onGoGrid={grid ? () => select(grid.id) : undefined}
        />
      </DatabaseStoreProvider>
    );
  }
  return (
    <DatabaseStoreProvider value={store}>
      <GridView key={active.id} view={active} source={view} tabs={tabs} />
    </DatabaseStoreProvider>
  );
}
