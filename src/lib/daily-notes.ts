// 每日笔记（Daily Notes）：纯逻辑层 —— 配置读写、日期工具、模板展开
//
// 设计：每日笔记不是新的数据类型，就是普通的文档页面 ——
//   · 根级目录页（名称取配置，默认「每日笔记」）
//   · 目录下按「年 / 月」分层，最内层是当天文档页（页面名如「10-02 周五」），一天一篇
// 这样搜索、标签、导出、备份、同步等既有能力全部直接可用。
import type { JSONContent } from "@tiptap/core";
import { useSettingsStore } from "@/stores/settings";
import { logger } from "./logger";

const CONFIG_KEY = "tsflowy:daily-notes";

export interface DailyNotesConfig {
  /** 收纳每日笔记的根级目录页名 */
  folderName: string;
  /** 新建笔记的正文模板（纯文本，一行一段；空 = 不写正文） */
  template: string;
  /** 启动时自动打开今日笔记 */
  openOnStart: boolean;
}

/** 模板占位符 → 取值 */
export interface DailyTemplateVars {
  /** 2026-10-02 */
  date: string;
  /** 周五 / Fri */
  weekday: string;
  /** 与 date 相同，作为标题写入 H1 的首行文本 */
  title: string;
}

export function defaultDailyNotesConfig(lang: "zh-CN" | "en-US"): DailyNotesConfig {
  return {
    folderName: lang === "en-US" ? "Daily notes" : "每日笔记",
    template: lang === "en-US" ? "## To do\n- [ ] \n\n## Notes\n" : "## 待办\n- [ ] \n\n## 记录\n",
    openOnStart: false,
  };
}

/** 读取配置；未配置或数据损坏时回落到当前语言的默认值 */
export function loadDailyNotesConfig(): DailyNotesConfig {
  const lang = useSettingsStore.getState().lang;
  const fallback = defaultDailyNotesConfig(lang);
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(CONFIG_KEY);
  } catch {
    return fallback;
  }
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw) as Partial<DailyNotesConfig>;
    return {
      folderName: typeof v.folderName === "string" && v.folderName.trim() ? v.folderName.trim() : fallback.folderName,
      template: typeof v.template === "string" ? v.template : fallback.template,
      openOnStart: v.openOnStart === true,
    };
  } catch (e) {
    logger.warn("dailyNotes", "config parse failed, fallback to default", e);
    return fallback;
  }
}

export function saveDailyNotesConfig(cfg: DailyNotesConfig): void {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
  } catch (e) {
    logger.warn("dailyNotes", "config persist failed", e);
  }
}

/* ————— 日期工具（全部按本地时区计算，避开 toISOString 的 UTC 偏移） ————— */

/** Date → 本地日期键 "YYYY-MM-DD" */
export function toDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** "YYYY-MM-DD" → 本地零点 Date；格式或日期非法（如 2026-13-40）返回 null */
export function parseDateKey(key: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const date = new Date(y, mo - 1, d);
  // 进位兜底：2 月 31 日会被 Date 滚到 3 月
  return toDateKey(date) === `${m[1]}-${m[2]}-${m[3]}` ? date : null;
}

/** 日期键前后偏移天数（跨月/跨年由 Date 自动进位） */
export function shiftDateKey(key: string, days: number): string {
  const date = parseDateKey(key) ?? new Date();
  date.setDate(date.getDate() + days);
  return toDateKey(date);
}

const WEEKDAYS: Record<"zh-CN" | "en-US", string[]> = {
  // getDay(): 0=周日
  "zh-CN": ["周日", "周一", "周二", "周三", "周四", "周五", "周六"],
  "en-US": ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
};

export function weekdayLabel(date: Date, lang: "zh-CN" | "en-US"): string {
  return WEEKDAYS[lang][date.getDay()] ?? "";
}

/** "2026-10-02" → "10-02"（侧边栏窄位展示用） */
export function shortDateKey(key: string): string {
  return key.length >= 10 ? key.slice(5) : key;
}

/** 每日笔记的页面名：月-日 + 星期，如 "10-02 周五" / "10-02 Fri"（非法日期回落到完整日期键） */
export function dailyNoteTitle(dateKey: string, lang: "zh-CN" | "en-US"): string {
  const date = parseDateKey(dateKey);
  if (!date) return dateKey;
  return `${dateKey.slice(5)} ${weekdayLabel(date, lang)}`;
}

/* ————— 模板 → 文档 JSON ————— */

const paragraph = (text: string): JSONContent =>
  text ? { type: "paragraph", content: [{ type: "text", text }] } : { type: "paragraph" };
const heading = (level: 2 | 3, text: string): JSONContent =>
  text
    ? { type: "heading", attrs: { level }, content: [{ type: "text", text }] }
    : { type: "heading", attrs: { level } };

/** 占位符插值：{{date}} / {{weekday}} / {{title}} */
export function interpolateTemplate(line: string, vars: DailyTemplateVars): string {
  return line
    .replace(/\{\{\s*date\s*\}\}/g, vars.date)
    .replace(/\{\{\s*weekday\s*\}\}/g, vars.weekday)
    .replace(/\{\{\s*title\s*\}\}/g, vars.title);
}

/**
 * 模板文本 → 块节点数组。支持的语法（够用即可，不做完整 Markdown）：
 *   `# / ## / ###`      → H2 / H3 / H3
 *   `- [ ]` / `- [x]`   → 待办（连续多行合并成一个任务列表）
 *   `- ` / `* `         → 无序列表（连续多行合并）
 *   `1. `               → 有序列表（连续多行合并）
 *   其余                → 段落
 * 空行只起分隔作用（也会结束上面正在累积的列表）。
 */
export function templateToBlocks(template: string, vars: DailyTemplateVars): JSONContent[] {
  const out: JSONContent[] = [];
  let tasks: JSONContent[] = [];
  let bullets: JSONContent[] = [];
  let ordered: JSONContent[] = [];

  const flush = () => {
    if (tasks.length > 0) {
      out.push({ type: "taskList", content: tasks });
      tasks = [];
    }
    if (bullets.length > 0) {
      out.push({ type: "bulletList", content: bullets });
      bullets = [];
    }
    if (ordered.length > 0) {
      out.push({ type: "orderedList", content: ordered });
      ordered = [];
    }
  };

  for (const raw of template.replace(/\r\n?/g, "\n").split("\n")) {
    const line = interpolateTemplate(raw, vars).trim();
    if (!line) {
      flush();
      continue;
    }
    const task = /^[-*]\s*\[([ xX])\]\s*(.*)$/.exec(line);
    if (task) {
      bullets = [];
      ordered = [];
      tasks.push({
        type: "taskItem",
        attrs: { checked: task[1].toLowerCase() === "x" },
        content: [paragraph(task[2].trim())],
      });
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      tasks = [];
      ordered = [];
      bullets.push({ type: "listItem", content: [paragraph(bullet[1].trim())] });
      continue;
    }
    const num = /^\d+[.)]\s+(.*)$/.exec(line);
    if (num) {
      tasks = [];
      bullets = [];
      ordered.push({ type: "listItem", content: [paragraph(num[1].trim())] });
      continue;
    }
    flush();
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      out.push(heading(h[1].length === 1 ? 2 : 3, h[2].trim()));
      continue;
    }
    out.push(paragraph(line));
  }
  flush();
  return out;
}

/** 每天新建的笔记正文：首行 H1（= 页面名，结构锁定要求）+ 分割线 + 模板展开 */
export function buildDailyNoteDoc(dateKey: string, template: string, lang: "zh-CN" | "en-US"): JSONContent {
  const vars = templateVarsFor(dateKey, lang);
  return {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: dailyNoteTitle(dateKey, lang) }] },
      { type: "horizontalRule" },
      ...templateToBlocks(template, vars),
    ],
  };
}

/** 收集每日笔记的目录页正文：首行 H1 + 分割线 + 一句说明 */
export function buildDailyFolderDoc(folderName: string, intro: string): JSONContent {
  return {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: folderName }] },
      { type: "horizontalRule" },
      ...(intro.trim() ? [paragraph(intro.trim())] : []),
    ],
  };
}

/** 按日期凑齐模板变量（dateKey / weekday / title 由同一天推导） */
export function templateVarsFor(dateKey: string, lang: "zh-CN" | "en-US"): DailyTemplateVars {
  const date = parseDateKey(dateKey) ?? new Date();
  return { date: dateKey, weekday: weekdayLabel(date, lang), title: dateKey };
}
