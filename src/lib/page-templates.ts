// 新建文档页的正文模板（空白 / 会议纪要 / 周计划 / 读书笔记）。
//
// 复用每日笔记的模板展开逻辑（templateToBlocks）：正文统一为
// 「首行 H1 = 页面名（结构锁定要求）+ 第二行分割线 + 模板展开的块」，
// 与 buildDailyNoteDoc 保持同一形状，可直接落库后由编辑器加载。
import type { JSONContent } from "@tiptap/core";
import type { MessageKey } from "./i18n";
import { templateToBlocks, templateVarsFor, toDateKey } from "./daily-notes";

export type PageTemplateId = "meeting" | "weekly" | "reading";

export interface PageTemplateDef {
  id: PageTemplateId;
  /** i18n 文案 key（下拉菜单展示名） */
  nameKey: MessageKey;
  /** 正文模板（纯文本，每行一段；语法见 templateToBlocks） */
  body: (lang: "zh-CN" | "en-US") => string;
}

const MEETING_ZH = [
  "## 会议信息",
  "- 时间：",
  "- 参会人：",
  "- 地点：",
  "",
  "## 议题",
  "1. 议题一",
  "2. 议题二",
  "",
  "## 讨论要点",
  "",
  "## 结论与决策",
  "",
  "## 待办事项",
  "- [ ] 待办（负责人 / 截止日期）",
].join("\n");

const MEETING_EN = [
  "## Meeting info",
  "- Date: ",
  "- Attendees: ",
  "- Location: ",
  "",
  "## Agenda",
  "1. Topic one",
  "2. Topic two",
  "",
  "## Discussion",
  "",
  "## Decisions",
  "",
  "## Action items",
  "- [ ] Action item (owner / due date)",
].join("\n");

const WEEKLY_ZH = [
  "## 本周目标",
  "1. 目标一",
  "2. 目标二",
  "",
  "## 重点任务",
  "- [ ] 任务一",
  "- [ ] 任务二",
  "- [ ] 任务三",
  "",
  "## 日程安排",
  "- 周一：",
  "- 周二：",
  "- 周三：",
  "- 周四：",
  "- 周五：",
  "",
  "## 本周复盘",
].join("\n");

const WEEKLY_EN = [
  "## Goals this week",
  "1. Goal one",
  "2. Goal two",
  "",
  "## Key tasks",
  "- [ ] Task one",
  "- [ ] Task two",
  "- [ ] Task three",
  "",
  "## Schedule",
  "- Mon: ",
  "- Tue: ",
  "- Wed: ",
  "- Thu: ",
  "- Fri: ",
  "",
  "## Retrospective",
].join("\n");

const READING_ZH = [
  "## 书籍信息",
  "- 书名：",
  "- 作者：",
  "- 阅读进度：",
  "",
  "## 核心观点",
  "",
  "## 精彩摘录",
  "",
  "## 我的思考",
  "",
  "## 行动清单",
  "- [ ] ",
].join("\n");

const READING_EN = [
  "## Book info",
  "- Title: ",
  "- Author: ",
  "- Progress: ",
  "",
  "## Key ideas",
  "",
  "## Highlights",
  "",
  "## My thoughts",
  "",
  "## Action list",
  "- [ ] ",
].join("\n");

export const PAGE_TEMPLATES: PageTemplateDef[] = [
  {
    id: "meeting",
    nameKey: "template.meeting",
    body: (lang) => (lang === "en-US" ? MEETING_EN : MEETING_ZH),
  },
  {
    id: "weekly",
    nameKey: "template.weekly",
    body: (lang) => (lang === "en-US" ? WEEKLY_EN : WEEKLY_ZH),
  },
  {
    id: "reading",
    nameKey: "template.reading",
    body: (lang) => (lang === "en-US" ? READING_EN : READING_ZH),
  },
];

export function findPageTemplate(id: string): PageTemplateDef | undefined {
  return PAGE_TEMPLATES.find((t) => t.id === id);
}

/**
 * 构造模板文档 JSON；未知模板返回 null（调用方据此不预填正文）。
 * 首行 H1 用页面名，保证结构锁定与「标题 ↔ 页面名」同源。
 */
export function buildPageTemplate(id: string, name: string, lang: "zh-CN" | "en-US"): JSONContent | null {
  const def = findPageTemplate(id);
  if (!def) return null;
  const vars = templateVarsFor(toDateKey(new Date()), lang);
  return {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: name }] },
      { type: "horizontalRule" },
      ...templateToBlocks(def.body(lang), vars),
    ],
  };
}
