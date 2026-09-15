import { ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { aggregateLabel, aggregateValue, aggregatesForType, type AggregateFn } from "@/lib/database-aggregate";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import type { CellValue, DatabaseField } from "@/types/database";

/**
 * 列汇总选择器（表格底部汇总行）：每列一个，点击换汇总函数。
 * 值本身就地算，所以菜单既是配置入口也是结果展示，不需要额外一行。
 */
export function AggregateMenu(props: {
  field: DatabaseField;
  /** 当前生效的函数；类型改过之后旧选择可能失效，由调用方归一后传入 */
  fn: AggregateFn | undefined;
  /** 参与统计的行 id */
  rowIds: string[];
  cells: Record<string, Record<string, CellValue>>;
  onPick: (fn: AggregateFn | undefined) => void;
}) {
  const { field, fn, rowIds, cells, onPick } = props;
  const candidates = aggregatesForType(field.field_type);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          data-testid={"aggregate-" + field.id}
          className="flex h-full w-full items-center gap-1 px-2 text-left text-[11px] hover:bg-neutral-100 dark:hover:bg-neutral-800"
          title={field.name}
        >
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              fn ? "text-neutral-700 dark:text-neutral-200" : "text-neutral-400",
            )}
          >
            {fn ? aggregateValue(fn, field, rowIds, cells) : t("grid.aggregateNone")}
          </span>
          <ChevronDown className="h-3 w-3 shrink-0 text-neutral-300 dark:text-neutral-600" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        <DropdownMenuLabel className="truncate">{field.name}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onPick(undefined)}>
          <span className="min-w-0 flex-1 truncate text-neutral-500">{t("grid.aggregateNone")}</span>
          {!fn && <span className="text-brand-600">✓</span>}
        </DropdownMenuItem>
        {candidates.map((candidate) => (
          <DropdownMenuItem key={candidate} onSelect={() => onPick(candidate)}>
            <span className="min-w-0 flex-1 truncate">{aggregateLabel(candidate)}</span>
            {candidate === fn && <span className="text-brand-600">✓</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
