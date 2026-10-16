// 任务行（taskItem）的「截止日期 + 负责人」元数据的纯逻辑：校验、状态判定、chip 文案、
// Markdown 行尾标记的编解码。单独成模块的原因：这些规则同时被 Markdown 导入导出（src/lib/markdown.ts）、
// HTML 导出（src/lib/export-page.ts）和编辑器扩展（src/features/editor/extensions/task-meta.ts）使用，
// 而分层规则是 lib 不反向依赖 features，所以共享部分只能放 lib。
// 应用只做 Windows 端，日期一律按本地日历日处理，不引入时区概念。

/** 任务行元数据；两者都可能为空，空值一律存 null 而不是空串（导出时好判断「要不要写标记」） */
export interface TaskMeta {
  due: string | null;
  assignee: string | null;
}

/** 截止日期状态：决定 chip 的颜色 */
export type DueState = "overdue" | "today" | "upcoming";

/** 任务行无元数据的共用返回值；冻结住，免得哪个调用方顺手改了污染到别处 */
export const EMPTY_TASK_META: TaskMeta = Object.freeze({ due: null, assignee: null });

/** 负责人文本长度上限：chip 只有一行，名字再长也得截断，否则把任务文字挤没 */
export const MAX_ASSIGNEE_LENGTH = 40;

const DUE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** `<!-- task due=2026-10-20 assignee=张三 -->`：due 在前、assignee 在后，
 *  这样负责人里可以带空格（末尾的空白由 `\s*-->` 吃掉） */
const TASK_META_RE = /\s*<!--\s*task(?:\s+due=(\d{4}-\d{2}-\d{2}))?(?:\s+assignee=([^<>]*?))?\s*-->\s*$/;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/** 日历日校验（含闰年）：`2026-02-30` 这种串 Date 会静默进位到 3 月，宁可判非法 */
function isRealCalendarDay(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12) return false;
  const limit = month === 2 && isLeapYear(year) ? 29 : MONTH_DAYS[month - 1];
  return day >= 1 && day <= limit;
}

/** 任意来源（attrs / data-due / Markdown 标记）的日期串 → `YYYY-MM-DD` 或 null */
export function normalizeDue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = DUE_RE.exec(value.trim());
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return isRealCalendarDay(year, month, day) ? value.trim() : null;
}

/** 负责人：去首尾空白、掐掉会破坏标记的字符，超长截断 */
export function normalizeAssignee(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/[<>]/g, "").trim();
  if (clean === "") return null;
  return clean.slice(0, MAX_ASSIGNEE_LENGTH);
}

/** 把任意 attrs 形状（可能缺字段、可能是字符串数字）收进 TaskMeta */
export function taskMetaOf(attrs: Record<string, unknown> | undefined): TaskMeta {
  return { due: normalizeDue(attrs?.due), assignee: normalizeAssignee(attrs?.assignee) };
}

/** 本地日历日的 `YYYY-MM-DD`（不取 UTC：跨零点时「今天」会算成昨天） */
export function todayIso(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/** ISO 日期可直接比字典序；`today` 由调用方传，方便单测固定「今天」 */
export function dueState(due: string | null, today: string): DueState | null {
  if (!due) return null;
  if (due < today) return "overdue";
  if (due === today) return "today";
  return "upcoming";
}

function isEmpty(meta: TaskMeta): boolean {
  return meta.due === null && meta.assignee === null;
}

/** chip 文案：`📅 2026-10-20 · 👤 张三`。日期保持 ISO 不做本地化，chip 要能一眼对回标记与导出；
 *  「逾期」不写进文案，由 dueState 单独着色（编辑器用 data 属性，HTML 导出用 class），避免同一行两处口径 */
export function taskMetaLabel(meta: TaskMeta): string {
  const parts: string[] = [];
  if (meta.due) parts.push(`📅 ${meta.due}`);
  if (meta.assignee) parts.push(`👤 ${meta.assignee}`);
  return parts.join(" · ");
}

/** Markdown 行尾标记；无元数据时返回空串，历史导出格式保持不变 */
export function encodeTaskMeta(meta: TaskMeta): string {
  if (isEmpty(meta)) return "";
  const segments: string[] = [];
  if (meta.due) segments.push(`due=${meta.due}`);
  if (meta.assignee) segments.push(`assignee=${meta.assignee}`);
  return ` <!-- task ${segments.join(" ")} -->`;
}

/** 从任务行文本末尾摘掉标记，返回去掉标记的正文与元数据 */
export function stripTaskMeta(text: string): { body: string; meta: TaskMeta } {
  const match = TASK_META_RE.exec(text);
  if (!match) return { body: text, meta: EMPTY_TASK_META };
  const meta: TaskMeta = { due: normalizeDue(match[1]), assignee: normalizeAssignee(match[2]) };
  // 只写着 `<!-- task -->` 的空标记照样摘掉，但别把正文里合法字段判丢
  return { body: text.slice(0, match.index), meta };
}
