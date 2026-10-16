// 块级操作的「做了 + 让用户知道」层：事务构造在 extensions/block-selection.ts（纯函数、可测），
// 这里只负责取 editor 状态、派发、以及失败与撤销的用户反馈。
// 手柄键盘路径（block-drag）和块菜单（block-menu）都走这两个函数，避免撤销 toast 写两份。
import type { Editor } from "@tiptap/core";
import { toast } from "sonner";

import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import {
  buildSpanDeleteTr,
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
export function deleteBlockSpan(editor: Editor, span: BlockSpan): boolean {
  const tr = buildSpanDeleteTr(editor.state, span);
  if (!tr) return false;
  editor.view.dispatch(tr);
  toast.success(t("block.deletedCount", { count: span.count }), {
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
