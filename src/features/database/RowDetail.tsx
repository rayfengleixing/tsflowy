import { X } from "lucide-react";
import type { DatabaseRow } from "@/types/database";
import type { View } from "@/types/models";
import { EditorPage } from "@/features/editor/EditorPage";
import { t } from "@/lib/i18n";

/** 行详情右侧滑出面板（说明书 6.1：宽 400px；每行一个文档，复用 M3 编辑器） */
export function RowDetailPanel({ row, view, onClose }: { row: DatabaseRow; view: View; onClose: () => void }) {
  return (
    <div className="absolute inset-y-0 right-0 z-30 flex w-[400px] flex-col border-l border-neutral-300 bg-white shadow-xl">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-neutral-200 px-3">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-neutral-800">
          {t("rowDetail.title", { name: `#${row.position + 1} ${view.name}` })}
        </span>
        <button
          data-testid="close-row-detail"
          className="flex h-6 w-6 items-center justify-center rounded text-neutral-500 hover:bg-neutral-200"
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <EditorPage view={view} />
      </div>
    </div>
  );
}