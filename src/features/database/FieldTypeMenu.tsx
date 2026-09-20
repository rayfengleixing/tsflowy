import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { fieldIcon } from "./field-icon";
import { t } from "@/lib/i18n";

/**
 * 属性图标即入口：点图标弹出类型列表直接改字段属性（对齐列头 FieldMenu 的类型子菜单样式）。
 * 类型列表由调用方给定——数据库字段用 FIELD_TYPES，页面属性用 6 种 pp 类型。
 */
export function FieldTypeMenu(props: {
  types: readonly string[];
  current: string;
  onSelect: (type: string) => void;
  testid?: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid={props.testid}
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-neutral-400 hover:bg-neutral-200 hover:text-neutral-600"
          title={t("field.changeType")}
          onClick={(e) => e.stopPropagation()}
        >
          {fieldIcon(props.current as never)}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 w-44 overflow-y-auto">
        {props.types.map((type) => (
          <DropdownMenuItem
            key={type}
            disabled={type === props.current}
            data-active={type === props.current}
            onSelect={() => props.onSelect(type)}
          >
            <span
              className={"mr-2 h-2 w-2 rounded-full " + (type === props.current ? "bg-brand-500" : "bg-neutral-300")}
            />
            {t(`field.type.${type}` as never)}
            {type === props.current && <span className="ml-2 text-[11px] text-neutral-400">✓</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
