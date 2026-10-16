// 任务行的「截止日期 / 负责人」：给 TipTap 自带的 TaskItem 追加 attrs。
// 为什么不自己写 NodeView：@tiptap/extension-list 的 TaskItem 已带一个原生 NodeView，
// 它的 update() 会用 getRenderedAttributes 把渲染属性刷到 <li> 上（node_modules/@tiptap/extension-list/dist/index.js:1312-1334），
// 属性写得对，编辑器里的 chip 就会自动出现与消失；换掉 NodeView 得重做 checkbox、嵌套、a11y 与拖拽手柄，风险大得多。
// 日期与姓名的校验、chip 文案、Markdown 标记的编解码都在 src/lib/task-meta.ts，导出端共用同一份口径。
import TaskItem from "@tiptap/extension-task-item";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { dueState, normalizeAssignee, normalizeDue, taskMetaLabel, todayIso, type TaskMeta } from "@/lib/task-meta";

/** taskItem 节点 attrs → 归一后的元数据（坏数据一律归零，不猜） */
export function taskMetaOfNode(node: PMNode): TaskMeta {
  return { due: normalizeDue(node.attrs.due), assignee: normalizeAssignee(node.attrs.assignee) };
}

/** 点手柄拿到的是 taskList 容器（顶层块），元数据属于容器里的某一行：按顺序列出每行的绝对 pos。
 *  与分栏同理，行的真实位置是「容器 before + 1 + 内容内偏移」。 */
export function taskItemPositions(doc: PMNode, listPos: number): { pos: number; node: PMNode }[] {
  const list = docAt(doc, listPos);
  if (list?.type.name !== "taskList") return [];
  const out: { pos: number; node: PMNode }[] = [];
  list.forEach((child, offset) => {
    if (child.type.name === "taskItem") out.push({ pos: listPos + 1 + offset, node: child });
  });
  return out;
}

/** 写某一行的日期 / 负责人（null 表示清除）。pos 不是 taskItem，或归一后没有变化，返回 null */
export function buildTaskMetaTr(state: EditorState, itemPos: number, meta: Partial<TaskMeta>): Transaction | null {
  const node = docAt(state.doc, itemPos);
  if (node?.type.name !== "taskItem") return null;
  const current = taskMetaOfNode(node);
  const next: TaskMeta = {
    due: meta.due === undefined ? current.due : normalizeDue(meta.due),
    assignee: meta.assignee === undefined ? current.assignee : normalizeAssignee(meta.assignee),
  };
  if (next.due === current.due && next.assignee === current.assignee) return null;
  return state.tr.setNodeMarkup(itemPos, undefined, { ...node.attrs, due: next.due, assignee: next.assignee });
}

/** nodeAt 对越界坐标抛 RangeError，先夹一道 */
function docAt(doc: PMNode, pos: number): PMNode | null {
  if (pos < 0 || pos >= doc.content.size) return null;
  return doc.nodeAt(pos);
}

/** due / assignee / chip 三个属性定义。拆成函数是为了在 node 环境下直接断言渲染结果
 *  （TipTap 的 getRenderedAttributes 要跑整套扩展注册，单测里划不来）。
 *  parentAttrs 传 TaskItem 自带的 checked。 */
export function buildTaskItemAttributes<T extends Record<string, unknown>>(parentAttrs: T) {
  return {
    ...parentAttrs,
    due: {
      default: null as string | null,
      parseHTML: (element: HTMLElement) => normalizeDue(element.getAttribute("data-due")),
      renderHTML: (attributes: { due?: unknown }) => {
        const due = normalizeDue(attributes.due);
        return due ? { "data-due": due } : {};
      },
    },
    assignee: {
      default: null as string | null,
      parseHTML: (element: HTMLElement) => normalizeAssignee(element.getAttribute("data-assignee")),
      renderHTML: (attributes: { assignee?: unknown }) => {
        const assignee = normalizeAssignee(attributes.assignee);
        return assignee ? { "data-assignee": assignee } : {};
      },
    },
    // 纯渲染用的派生属性：没人往文档状态里写它，值恒等于 default，Node.toJSON 会省略，
    // 所以文档 JSON 不多字段，但 renderHTML 拿得到整包 attrs，一次拼出 chip 文案与状态。
    // 状态是按渲染当时的「今天」算的：页面重开或该行有改动才会重新着色，跨零点不主动刷新。
    chip: {
      default: null as string | null,
      renderHTML: (attributes: { due?: unknown; assignee?: unknown }) => {
        const meta: TaskMeta = {
          due: normalizeDue(attributes.due),
          assignee: normalizeAssignee(attributes.assignee),
        };
        const label = taskMetaLabel(meta);
        if (!label) return {};
        const state = meta.due ? dueState(meta.due, todayIso()) : null;
        return { "data-task-meta": label, ...(state ? { "data-task-state": state } : {}) };
      },
    },
  };
}

export const TaskItemWithMeta = TaskItem.extend({
  addAttributes() {
    return buildTaskItemAttributes((this.parent?.() ?? {}) as Record<string, unknown>);
  },
});
