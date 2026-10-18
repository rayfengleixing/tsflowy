// 任务清单的「截止日期 / 负责人」面板：由块菜单在选中 taskList 容器时嵌入。
// 之所以做成面板而不是逐行弹窗：点块手柄拿到的是整个 taskList（顶层块），单行没有独立入口；
// 面板里用「上一行 / 下一行」在一列任务间移动，比让每一行都长出可点的 UI 更省事，也不动 TipTap 原生 NodeView。
import { useEffect, useState } from "react";
import type { Editor } from "@tiptap/core";
import { CalendarDays, ChevronDown, ChevronUp, UserRound, X } from "lucide-react";
import { t } from "@/lib/i18n";
import { todayIso, type TaskMeta } from "@/lib/task-meta";
import { buildTaskMetaTr, taskItemPositions, taskMetaOfNode } from "./extensions/task-meta";
import { IconBtn } from "./floating-menu";

const EMPTY: TaskMeta = { due: null, assignee: null };

export function TaskMetaPanel({ editor, listPos }: { editor: Editor; listPos: number }) {
  const items = taskItemPositions(editor.state.doc, listPos);
  const [index, setIndex] = useState(0);
  // 面板开着时列表可能被别处改短，越界就退回最后一行
  const safeIndex = items.length === 0 ? 0 : Math.min(index, items.length - 1);
  const target = safeIndex < items.length ? items[safeIndex] : undefined;
  const meta = target ? taskMetaOfNode(target.node) : EMPTY;
  const [due, setDue] = useState(meta.due ?? "");
  const [assignee, setAssignee] = useState(meta.assignee ?? "");

  // 换行 / 外部改过这一行时，把输入框同步回节点里的真值
  useEffect(() => {
    setDue(meta.due ?? "");
    setAssignee(meta.assignee ?? "");
  }, [safeIndex, meta.due, meta.assignee]);

  if (items.length === 0 || !target) return null;

  const commit = (patch: Partial<TaskMeta>) => {
    const tr = buildTaskMetaTr(editor.state, target.pos, patch);
    if (tr) editor.view.dispatch(tr);
  };

  const applyDue = (value: string) => {
    setDue(value);
    commit({ due: value === "" ? null : value });
  };

  const applyAssignee = (value: string) => {
    setAssignee(value);
    commit({ assignee: value === "" ? null : value });
  };

  // 输入框必须挡住块菜单容器上的 preventDefault，否则点不进去、光标也放不了
  const keepFocus = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <div className="border-b border-neutral-100 px-2 pb-1.5 dark:border-neutral-800">
      <div className="mb-1 flex items-center gap-1">
        <CalendarDays className="h-3.5 w-3.5 text-neutral-400" />
        <span className="text-[11px] text-neutral-400">{t("taskMeta.title")}</span>
        <span className="ml-auto flex items-center gap-0.5">
          <IconBtn
            title={t("taskMeta.prev")}
            disabled={safeIndex === 0}
            onClick={() => setIndex((i) => Math.max(0, i - 1))}
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </IconBtn>
          <span className="text-[10px] tabular-nums text-neutral-400">
            {safeIndex + 1}/{items.length}
          </span>
          <IconBtn
            title={t("taskMeta.next")}
            disabled={safeIndex >= items.length - 1}
            onClick={() => setIndex((i) => Math.min(items.length - 1, i + 1))}
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </IconBtn>
        </span>
      </div>

      <label className="mb-1 flex items-center gap-1">
        <span className="w-10 shrink-0 text-[11px] text-neutral-500 dark:text-neutral-400">{t("taskMeta.due")}</span>
        <input
          type="date"
          value={due}
          max="9999-12-31"
          onChange={(e) => applyDue(e.target.value)}
          onMouseDown={keepFocus}
          className="min-w-0 flex-1 rounded border border-neutral-200 bg-white px-1.5 py-0.5 text-[12px] outline-none focus:border-brand-500 dark:border-neutral-700 dark:bg-neutral-800"
        />
        <IconBtn title={t("taskMeta.today")} onClick={() => applyDue(todayIso())}>
          <CalendarDays className="h-3.5 w-3.5" />
        </IconBtn>
        <IconBtn title={t("taskMeta.clear")} disabled={due === ""} onClick={() => applyDue("")}>
          <X className="h-3.5 w-3.5" />
        </IconBtn>
      </label>

      <div className="flex items-center gap-1">
        <span className="w-10 shrink-0 text-[11px] text-neutral-500 dark:text-neutral-400">
          <UserRound className="mr-0.5 inline h-3 w-3" />
          {t("taskMeta.assignee")}
        </span>
        <input
          type="text"
          value={assignee}
          placeholder={t("taskMeta.assigneePlaceholder")}
          aria-label={t("taskMeta.assignee")}
          onChange={(e) => setAssignee(e.target.value)}
          onBlur={(e) => applyAssignee(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              applyAssignee(e.currentTarget.value);
              e.currentTarget.blur();
            }
          }}
          onMouseDown={keepFocus}
          className="min-w-0 flex-1 rounded border border-neutral-200 bg-white px-1.5 py-0.5 text-[12px] outline-none focus:border-brand-500 dark:border-neutral-700 dark:bg-neutral-800"
        />
        <IconBtn title={t("taskMeta.clear")} disabled={assignee === ""} onClick={() => applyAssignee("")}>
          <X className="h-3.5 w-3.5" />
        </IconBtn>
      </div>

      <p className="mt-1 text-[10px] leading-relaxed text-neutral-400">{t("taskMeta.hint")}</p>
    </div>
  );
}
