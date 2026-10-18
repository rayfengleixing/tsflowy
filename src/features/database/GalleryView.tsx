import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ImageOff, LayoutList, Plus } from "lucide-react";
import { toast } from "sonner";
import { useDbStore } from "@/stores/database-context";
import { applyFilters, isCellEmpty, sortRows } from "@/lib/database-query";
import { computeEvaluatedCells, rowCellsOf } from "@/lib/database-evaluated-cells";
import { attachmentRefs, formatCellValue, parseFieldOptions } from "@/lib/database-values";
import { isImageFile } from "@/lib/assets";
import { useRelationDbs } from "./use-database-data";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CellReadValue, useAssetUrl } from "./cell-display";
import { ROW_FOCUS_CLASS, useRowFocus } from "./rowFocus";
import { RowDetailPanel } from "./RowDetail";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import { patchViewConfig, readViewConfig } from "@/lib/view-config";
import type { CellValue, DatabaseField, DatabaseRow } from "@/types/database";
import type { View } from "@/types/models";

/**
 * Gallery 画廊视图：卡片墙 + 附件图片封面，适合封面驱动的数据集（商品、人物、参考图）。
 * 封面只认附件字段里的图片；副信息与看板卡片共用一份配置（cardFieldIds）。
 */
export function GalleryView({
  view,
  source,
  tabs,
  onGoGrid,
}: {
  /** 当前视图：封面字段等显示配置的归属 */
  view: View;
  /** 宿主页面：行详情的父子归属 */
  source: View;
  /** 顶栏左侧的视图标签栏 */
  tabs?: React.ReactNode;
  /** 没有附件字段时引导回到表格视图 */
  onGoGrid?: () => void;
}) {
  const store = useDbStore();
  const load = useDbStore((s) => s.load);
  const { fields, rows, cells, loading, sorts, filters, filterMode, rowDetail } = store;
  const { openRowDetail, closeRowDetail } = store;

  const [coverFieldId, setCoverFieldId] = useState<string | null>(() => readViewConfig(view).galleryFieldId ?? null);
  // null = 未配置（沿用"主字段之后前 3 个可见字段"的默认启发式）；数组 = 用户显式勾选
  const [cardFieldIds, setCardFieldIds] = useState<string[] | null>(() => readViewConfig(view).cardFieldIds ?? null);

  useEffect(() => {
    load(view).catch((e: unknown) => logger.error("gallery.load", e));
  }, [load, view]);

  const changeCoverField = (id: string | null) => {
    setCoverFieldId(id);
    patchViewConfig(view, { galleryFieldId: id ?? "" });
  };

  // 没配置过就自动落到第一个附件字段（封面是画廊的全部意义，别让首屏空白）
  useEffect(() => {
    if (fields.length === 0) return;
    const attachment = fields.filter((f) => f.field_type === "attachment");
    if (coverFieldId && attachment.some((f) => f.id === coverFieldId)) return;
    setCoverFieldId(attachment[0]?.id ?? null);
  }, [fields, coverFieldId]);

  const visibleFields = useMemo(() => fields.filter((f) => f.is_hidden === 0), [fields]);
  const primaryField = visibleFields[0] ?? null;
  const coverField = fields.find((f) => f.id === coverFieldId) ?? null;
  const attachmentFields = useMemo(() => fields.filter((f) => f.field_type === "attachment"), [fields]);

  const cardCandidates = useMemo(() => visibleFields.slice(1), [visibleFields]);
  const defaultCardFieldIds = useMemo(() => cardCandidates.slice(0, 3).map((f) => f.id), [cardCandidates]);
  const cardSubFields = useMemo(() => {
    const ids = cardFieldIds ?? defaultCardFieldIds;
    return ids.map((id) => cardCandidates.find((f) => f.id === id)).filter((f): f is DatabaseField => !!f);
  }, [cardCandidates, cardFieldIds, defaultCardFieldIds]);

  const relationDbOf = useRelationDbs(fields);

  const sortableCells = useMemo(
    () => computeEvaluatedCells(rows, cells, fields, relationDbOf).sortable,
    [rows, cells, fields, relationDbOf],
  );

  const displayRows = useMemo(() => {
    const filtered = applyFilters(rows, sortableCells, filters, fields, filterMode);
    return sortRows(filtered, sortableCells, sorts);
  }, [rows, sortableCells, filters, fields, filterMode, sorts]);

  const evaluated = useMemo(
    () => computeEvaluatedCells(displayRows, cells, fields, relationDbOf).display,
    [displayRows, cells, fields, relationDbOf],
  );

  const toggleCardField = (id: string) => {
    const current = cardFieldIds ?? defaultCardFieldIds;
    const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
    setCardFieldIds(next);
    patchViewConfig(view, { cardFieldIds: next });
  };

  const { scrollerRef, focusRowId } = useRowFocus(displayRows.length);

  const addRow = async () => {
    try {
      await store.addRow();
    } catch (e) {
      toast.error(t("error.db", { message: String(e) }));
    }
  };

  if (loading && fields.length === 0) {
    return <div className="flex h-full items-center justify-center text-sm text-neutral-500">{t("app.loading")}</div>;
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-white">
      {/* 顶栏（44px，和其它视图一致）：左侧为页内视图切换 */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-neutral-200 px-6">
        <div className="flex min-w-0 flex-1 items-center">{tabs}</div>

        <div className="flex shrink-0 items-center gap-1">
          <div className="flex items-center gap-1.5 rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-700">
            <span className="text-neutral-500">{t("gallery.coverField")}:</span>
            <select
              className="bg-transparent text-xs outline-none"
              aria-label={t("gallery.coverField")}
              value={coverFieldId ?? ""}
              onChange={(e) => changeCoverField(e.target.value || null)}
            >
              {attachmentFields.length === 0 && <option value="">{t("gallery.coverNone")}</option>}
              {attachmentFields.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm">
                <LayoutList className="h-3.5 w-3.5" />
                {t("board.cardFields")}
                <ChevronDown className="h-3 w-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>{t("board.cardFieldsHint")}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {cardCandidates.map((f) => (
                <DropdownMenuCheckboxItem
                  key={f.id}
                  checked={(cardFieldIds ?? defaultCardFieldIds).includes(f.id)}
                  onSelect={(e) => e.preventDefault()}
                  onCheckedChange={() => toggleCardField(f.id)}
                >
                  {f.name}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <span className="text-xs text-neutral-400">{displayRows.length}</span>
          <Button variant="ghost" size="sm" onClick={() => void addRow()}>
            <Plus className="h-3.5 w-3.5" />
            {t("row.new")}
          </Button>
        </div>
      </div>

      {!coverField ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <div className="text-4xl">🖼️</div>
          <h2 className="text-base font-semibold text-neutral-800">{t("gallery.noField")}</h2>
          <p className="max-w-md text-sm text-neutral-500">{t("gallery.noFieldDesc")}</p>
          {onGoGrid && (
            <Button size="sm" onClick={onGoGrid}>
              {t("board.goGrid")}
            </Button>
          )}
        </div>
      ) : (
        <div ref={scrollerRef} className="min-h-0 flex-1 overflow-auto">
          {displayRows.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-neutral-400">
              {t("databaseView.noRows")}
            </div>
          ) : (
            <div className="grid gap-3 p-4 [grid-template-columns:repeat(auto-fill,minmax(220px,1fr))]">
              {displayRows.map((row) => (
                <GalleryCard
                  key={row.id}
                  row={row}
                  primaryField={primaryField}
                  coverField={coverField}
                  cardSubFields={cardSubFields}
                  rowCells={rowCellsOf(evaluated, cells, row.id)}
                  focused={focusRowId === row.id}
                  onOpenDetail={() => void openRowDetail(row, source)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {rowDetail && <RowDetailPanel row={rowDetail.row} view={rowDetail.view} onClose={closeRowDetail} />}
    </div>
  );
}

function GalleryCard({
  row,
  primaryField,
  coverField,
  cardSubFields,
  rowCells,
  focused,
  onOpenDetail,
}: {
  row: DatabaseRow;
  primaryField: DatabaseField | null;
  coverField: DatabaseField;
  cardSubFields: DatabaseField[];
  rowCells: Record<string, CellValue | undefined>;
  focused: boolean;
  onOpenDetail: () => void;
}) {
  const title = primaryField
    ? formatCellValue(
        primaryField.field_type,
        rowCells[primaryField.id] ?? null,
        parseFieldOptions(primaryField.options),
      )
    : "";
  // 封面取该附件字段里的第一张图片；整卡可点进行详情
  const coverPath = useMemo(() => {
    const refs = attachmentRefs(rowCells[coverField.id] ?? null);
    const image = refs.find((a) => isImageFile(a.name));
    return image?.path ?? null;
  }, [rowCells, coverField.id]);

  const props = cardSubFields
    .map((f) => ({ field: f, value: rowCells[f.id] ?? null }))
    .filter((p) => !isCellEmpty(p.value));

  return (
    <div
      data-row-id={row.id}
      role="button"
      tabIndex={0}
      className={cn(
        "group/card cursor-pointer overflow-hidden rounded-lg border border-neutral-200 bg-white text-left shadow-sm transition hover:border-neutral-300 hover:shadow-md active:scale-[.99] dark:border-neutral-700 dark:bg-neutral-800",
        focused && ROW_FOCUS_CLASS,
      )}
      onClick={onOpenDetail}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpenDetail();
        }
      }}
    >
      <GalleryCover path={coverPath} />
      <div className="flex flex-col gap-1 px-2.5 py-2">
        <span className="truncate text-[13px] font-medium text-neutral-900 dark:text-neutral-100">
          {title || <span className="font-normal text-neutral-400">{t("board.cardNamePlaceholder")}</span>}
        </span>
        {props.map((p) => (
          <span key={p.field.id} className="flex min-w-0 items-center gap-1.5 text-[11px]">
            <span className="w-20 shrink-0 truncate text-neutral-400 dark:text-neutral-500">{p.field.name}</span>
            <span className="min-w-0 flex-1">
              <CellReadValue field={p.field} value={p.value} />
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** 封面：3:2 区域内等比裁切；无图片或资源解析失败时给占位，不塌成一条 */
function GalleryCover({ path }: { path: string | null }) {
  const url = useAssetUrl(path);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  if (!url || failed) {
    return (
      <div className="flex h-[132px] items-center justify-center bg-neutral-100 text-neutral-300 dark:bg-neutral-900 dark:text-neutral-600">
        <ImageOff className="h-5 w-5" />
      </div>
    );
  }
  return (
    <img
      src={url}
      alt=""
      loading="lazy"
      draggable={false}
      onError={() => setFailed(true)}
      className="h-[132px] w-full object-cover"
    />
  );
}
