import { useEffect, useState } from "react";
import { viewApi } from "@/lib/db";
import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import { patchViewConfig, readViewConfig } from "@/lib/view-config";
import { toast } from "sonner";
import { BoardView } from "./BoardView";
import { CalendarView } from "./CalendarView";
import { GridView } from "./GridView";
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

  useEffect(() => {
    let alive = true;
    setRows([view]);
    setActiveId(view.id);
    viewApi
      .listForSource(view.id)
      .then((list) => {
        if (!alive) return;
        setRows(list.length > 0 ? list : [view]);
        // 上次停留的视图可能已被删除：校验存在后再恢复，否则回落到宿主
        const saved = readViewConfig(view).activeViewId;
        if (saved && list.some((v) => v.id === saved)) setActiveId(saved);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        logger.error("database-page.list-views", e);
        toast.error(t("error.db", { message: String(e) }));
      });
    return () => {
      alive = false;
    };
    // view 是树快照，只有换页面才需要重取（改名等由本地 state 同步）
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      <BoardView
        key={active.id}
        view={active}
        source={view}
        tabs={tabs}
        onGoGrid={grid ? () => select(grid.id) : undefined}
      />
    );
  }
  if (active.layout === "calendar") {
    return (
      <CalendarView
        key={active.id}
        view={active}
        source={view}
        tabs={tabs}
        onGoGrid={grid ? () => select(grid.id) : undefined}
      />
    );
  }
  return <GridView key={active.id} view={active} source={view} tabs={tabs} />;
}
