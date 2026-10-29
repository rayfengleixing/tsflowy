import { useMemo, useState } from "react";
import { Palette } from "lucide-react";
import { Button } from "@/components/ui/button";
import { buildCondIndex, type CondFormatRule } from "@/lib/database-cond-format";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { patchViewConfig, readViewConfig } from "@/lib/view-config";
import { useDbStore } from "@/stores/database-context";
import { CondFormatDialog } from "./CondFormatDialog";
import type { View } from "@/types/models";
import type { CellValue } from "@/types/database";

/**
 * 条件格式条：顶栏那一个按钮 + 规则编辑弹窗，规则按视图持久化到 views.extra。
 *
 * 原来这套状态长在表格视图里，抽出来给各视图共用。接法与筛选/排序条同形：
 * 一个 hook 拿状态，button 进顶栏那一行，dialog 挂在 JSX 末尾。渲染取色用 `index`
 * （配合 `toneOfIndex`；第三个参数传该视图已算好的展示图，公式列也能当条件）。
 */
export function useCondFormat(view: View, rowIds: string[], cells: Record<string, Record<string, CellValue>>) {
  const fields = useDbStore((s) => s.fields);
  const [rules, setRules] = useState<CondFormatRule[]>(() => readViewConfig(view).condFormats ?? []);
  const [open, setOpen] = useState(false);
  // 整屏一次算出「行 × 列 → 颜色」索引，每格只做两次 Map 查
  const index = useMemo(() => buildCondIndex(rules, rowIds, cells, fields), [rules, rowIds, cells, fields]);
  const changeRules = (next: CondFormatRule[]) => {
    setRules(next);
    patchViewConfig(view, { condFormats: next });
  };
  return { rules, index, open, setOpen, changeRules };
}

export type CondFormatBar = ReturnType<typeof useCondFormat>;

export function CondFormatButton({ bar }: { bar: CondFormatBar }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => bar.setOpen(true)}
      title={t("cond.title")}
      className={cn(bar.rules.length > 0 && "bg-brand-100 text-brand-600")}
    >
      <Palette className="h-3.5 w-3.5" />
      {t("cond.title")}
      {bar.rules.length > 0 && (
        <span className="ml-1 rounded-full bg-brand-500 px-1.5 text-[10px] text-white">{bar.rules.length}</span>
      )}
    </Button>
  );
}

export function CondFormatDialogHost({ bar }: { bar: CondFormatBar }) {
  const fields = useDbStore((s) => s.fields);
  return (
    <CondFormatDialog
      open={bar.open}
      onOpenChange={bar.setOpen}
      fields={fields}
      rules={bar.rules}
      onChange={bar.changeRules}
    />
  );
}
