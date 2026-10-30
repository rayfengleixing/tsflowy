import { useState } from "react";
import { ArrowUpDown, Filter } from "lucide-react";
import { Button } from "@/components/ui/button";
import { countFilterLeaves } from "@/lib/database/database-query";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useDbStore } from "@/stores/database-context";
import { FilterBar } from "./FilterBar";
import { SortBar } from "./SortBar";

/**
 * 筛选 / 排序条：顶栏上的两个按钮 + 顶栏下方展开的面板。
 *
 * 六个视图共用同一份 store 配置（按视图持久化到 views.extra），所以任何视图想用
 * 筛选/排序都必须把按钮和面板成对挂上：buttons 进顶栏那一行，panels 挂在该行下面
 * （它们是整宽的 border-b 条，塞进行内会把顶栏撑高）。
 */
export function useQueryBar() {
  const [filterOpen, setFilterOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  return {
    filterOpen,
    sortOpen,
    toggleFilter: () => setFilterOpen((v) => !v),
    toggleSort: () => setSortOpen((v) => !v),
    closeFilter: () => setFilterOpen(false),
    closeSort: () => setSortOpen(false),
  };
}

export type QueryBar = ReturnType<typeof useQueryBar>;

export function QueryButtons({ bar }: { bar: QueryBar }) {
  const filters = useDbStore((s) => s.filters);
  const sorts = useDbStore((s) => s.sorts);
  const badge = (n: number) =>
    n > 0 ? <span className="ml-1 rounded-full bg-brand-500 px-1.5 text-[10px] text-white">{n}</span> : null;
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={bar.toggleFilter}
        aria-expanded={bar.filterOpen}
        className={cn(bar.filterOpen && "bg-brand-100 text-brand-600")}
      >
        <Filter className="h-3.5 w-3.5" />
        {t("filter.title")}
        {badge(countFilterLeaves(filters))}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={bar.toggleSort}
        aria-expanded={bar.sortOpen}
        className={cn(bar.sortOpen && "bg-brand-100 text-brand-600")}
      >
        <ArrowUpDown className="h-3.5 w-3.5" />
        {t("sort.title")}
        {badge(sorts.length)}
      </Button>
    </>
  );
}

export function QueryPanels({ bar }: { bar: QueryBar }) {
  const store = useDbStore();
  const { fields, filters, filterMode, sorts } = store;
  return (
    <>
      {bar.filterOpen && (
        <FilterBar
          fields={fields}
          filters={filters}
          mode={filterMode}
          onChange={store.setFilters}
          onClose={bar.closeFilter}
        />
      )}
      {bar.sortOpen && <SortBar fields={fields} sorts={sorts} onChange={store.setSorts} onClose={bar.closeSort} />}
    </>
  );
}
