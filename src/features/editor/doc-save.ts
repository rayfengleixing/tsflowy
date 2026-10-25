// 文档落库的节流与观测（从 EditorPage.tsx 原样搬出）：800ms 防抖是产品口径，
// 慢与大只做一次性提示，不参与保存成败。
import { toast } from "sonner";
import { logger } from "@/lib/logger";
import { t } from "@/lib/i18n";

export const AUTOSAVE_MS = 800;
/** 落库观测阈值：超过其一即 warn + 一次性提示（只观测，不影响保存本身） */
const SAVE_SLOW_MS = 1200;
const SAVE_BIG_CHARS = 300_000;

/** 本次会话内已提示过「保存偏慢」的文档：超阈值只提示一次，避免每次自动保存都弹 */
const slowSaveWarned = new Set<string>();

/** 落库耗时/体积记录：慢或大时 warn（生产环境保留），否则 debug */
export function reportSaveMetrics(viewId: string, chars: number, ms: number) {
  // 取整沿用 toFixed：这一段原本写在被 tiptap 的 Math 扩展遮蔽了全局 Math 的文件里，搬过来一字不改
  const elapsed = Number(ms.toFixed(0));
  if (elapsed >= SAVE_SLOW_MS || chars >= SAVE_BIG_CHARS) {
    logger.warn("doc.save", { viewId, chars, ms: elapsed });
    if (!slowSaveWarned.has(viewId)) {
      slowSaveWarned.add(viewId);
      toast.warning(t("editor.saveSlow", { size: Number((chars / 1000).toFixed(0)), ms: elapsed }));
    }
  } else {
    logger.debug("doc.save", { viewId, chars, ms: elapsed });
  }
}
