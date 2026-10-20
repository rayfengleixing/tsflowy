// 块级操作的「做了 + 让用户知道」层：事务构造在 extensions/block-selection.ts（纯函数、可测），
// 这里只负责取 editor 状态、派发、以及失败与撤销的用户反馈。
// 手柄键盘路径（block-drag）和块菜单（block-menu）都走这两个函数，避免撤销 toast 写两份。
import type { Editor } from "@tiptap/core";
import { toast } from "sonner";

import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import { copyRangeToClipboard } from "@/features/editor/block-clipboard";
import {
  buildSpanDeleteTr,
  buildSpanDuplicateTr,
  buildSpanMoveTr,
  spanMoveTarget,
  type BlockSpan,
} from "@/features/editor/extensions/block-selection";

/** 整段上/下搬一格；到头或撞结构锁定时返回 false，由调用方决定要不要提示 */
export function moveBlockSpan(editor: Editor, span: BlockSpan, dir: -1 | 1): boolean {
  const at = spanMoveTarget(editor.state.doc, span, dir);
  if (at === null) return false;
  const tr = buildSpanMoveTr(editor.state, span, at);
  if (!tr) return false;
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

/** 删掉整段并给一条可撤销的 toast：区间删除没有 Ctrl+Z 的心理预期，必须当场能回退 */
function landSpanDelete(editor: Editor, span: BlockSpan, detail: string): boolean {
  const tr = buildSpanDeleteTr(editor.state, span);
  if (!tr) return false;
  editor.view.dispatch(tr);
  toast.success(detail, {
    action: {
      label: t("block.undo"),
      onClick: () => {
        try {
          editor.chain().focus().undo().run();
        } catch (e) {
          logger.warn("block span undo failed", e);
          toast.error(t("block.undoFailed"));
        }
      },
    },
  });
  return true;
}

export function deleteBlockSpan(editor: Editor, span: BlockSpan): boolean {
  return landSpanDelete(editor, span, t("block.deletedCount", { count: span.count }));
}

/** 复制整段：区间夹着半个块（选区落进容器内部）时拒绝，不偷偷补结构 */
export async function copyBlockSpan(editor: Editor, span: BlockSpan): Promise<boolean> {
  const ok = await copyRangeToClipboard(editor, span.from, span.to);
  if (ok) toast.success(t("block.copiedCount", { count: span.count }));
  return ok;
}

/** 剪切 = 先写进剪贴板再删；写入失败就什么都不动，否则用户失去的块回不来 */
export async function cutBlockSpan(editor: Editor, span: BlockSpan): Promise<boolean> {
  if (!(await copyRangeToClipboard(editor, span.from, span.to))) return false;
  return landSpanDelete(editor, span, t("block.cutCount", { count: span.count }));
}

/** 整段就地多插一份，选区跟着搬到副本上（撤销走 Ctrl+Z，不占 toast） */
export function duplicateBlockSpan(editor: Editor, span: BlockSpan): boolean {
  const tr = buildSpanDuplicateTr(editor.state, span);
  if (!tr) return false;
  editor.view.dispatch(tr.scrollIntoView());
  toast.success(t("block.duplicatedCount", { count: span.count }));
  return true;
}
