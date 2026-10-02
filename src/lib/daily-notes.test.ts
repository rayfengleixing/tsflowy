import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { LockedHeading } from "@/features/editor/extensions/document-structure-lock";
import {
  buildDailyFolderDoc,
  buildDailyNoteDoc,
  defaultDailyNotesConfig,
  interpolateTemplate,
  parseDateKey,
  shiftDateKey,
  shortDateKey,
  templateToBlocks,
  templateVarsFor,
  toDateKey,
  weekdayLabel,
} from "./daily-notes";

// 与 EditorPage 注册一致：用真实 schema 校验生成的文档 JSON，
// 防新建每日笔记时编辑器报 Invalid content（与 welcome-doc.test.ts 同思路）
const schema = getSchema([
  StarterKit.configure({ heading: false }),
  LockedHeading.configure({ levels: [1, 2, 3] }),
  TaskList,
  TaskItem.configure({ nested: true }),
]);

describe("日期工具", () => {
  it("toDateKey 按本地时区生成 YYYY-MM-DD（不走 UTC）", () => {
    // 本地零点：UTC+8 下 toISOString 会落到前一天，这里必须仍是 1 月 1 日
    expect(toDateKey(new Date(2026, 0, 1))).toBe("2026-01-01");
    expect(toDateKey(new Date(2026, 9, 2, 23, 59))).toBe("2026-10-02");
  });

  it("parseDateKey 解析本地零点，非法输入返回 null", () => {
    expect(parseDateKey("2026-10-02")?.getDate()).toBe(2);
    expect(parseDateKey("2026-10-02")?.getMonth()).toBe(9);
    expect(parseDateKey("2026-13-01")).toBeNull();
    expect(parseDateKey("2026-02-31")).toBeNull();
    expect(parseDateKey("20261002")).toBeNull();
  });

  it("shiftDateKey 跨月跨年进位", () => {
    expect(shiftDateKey("2026-10-02", -1)).toBe("2026-10-01");
    expect(shiftDateKey("2026-10-31", 1)).toBe("2026-11-01");
    expect(shiftDateKey("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("weekdayLabel 按语言给出星期", () => {
    const d = new Date(2026, 9, 2); // 2026-10-02 是周五
    expect(weekdayLabel(d, "zh-CN")).toBe("周五");
    expect(weekdayLabel(d, "en-US")).toBe("Fri");
  });

  it("shortDateKey 截到 月-日", () => {
    expect(shortDateKey("2026-10-02")).toBe("10-02");
    expect(shortDateKey("bad")).toBe("bad");
  });
});

describe("interpolateTemplate", () => {
  const vars = templateVarsFor("2026-10-02", "zh-CN");

  it("替换三个占位符（容忍空格）", () => {
    expect(interpolateTemplate("{{date}} {{ weekday }} {{title}}", vars)).toBe("2026-10-02 周五 2026-10-02");
  });

  it("没有占位符时原样返回", () => {
    expect(interpolateTemplate("普通一行", vars)).toBe("普通一行");
  });
});

describe("templateToBlocks", () => {
  const vars = templateVarsFor("2026-10-02", "zh-CN");

  it("连续的待办合并成一个任务列表，空行断开", () => {
    const blocks = templateToBlocks("- [ ] 甲\n- [x] 乙\n\n- [ ] 丙", vars);
    expect(blocks.map((b) => b.type)).toEqual(["taskList", "taskList"]);
    expect((blocks[0].content ?? []).map((i) => Boolean(i.attrs?.checked))).toEqual([false, true]);
    expect(blocks[1].content?.[0].attrs?.checked).toBe(false);
  });

  it("无序列表与有序列表各自合并，遇到段落断开", () => {
    const blocks = templateToBlocks("- 甲\n- 乙\n说明\n1. 一\n2. 二", vars);
    expect(blocks.map((b) => b.type)).toEqual(["bulletList", "paragraph", "orderedList"]);
    expect(blocks[2].content?.length).toBe(2);
  });

  it("井号映射为 H2/H3（H1 已被标题占用）", () => {
    const blocks = templateToBlocks("# 一级\n## 二级\n### 三级", vars);
    expect(blocks.map((b) => Number(b.attrs?.level))).toEqual([2, 3, 3]);
  });

  it("空模板产出空数组", () => {
    expect(templateToBlocks("", vars)).toEqual([]);
    expect(templateToBlocks("\n\n  \n", vars)).toEqual([]);
  });
});

describe("buildDailyNoteDoc", () => {
  it("首行 H1 = 日期、第二行分割线，符合结构锁定", () => {
    const doc = schema.nodeFromJSON(
      buildDailyNoteDoc("2026-10-02", defaultDailyNotesConfig("zh-CN").template, "zh-CN"),
    );
    expect(doc.child(0).type.name).toBe("heading");
    expect(doc.child(0).attrs.level).toBe(1);
    expect(doc.child(0).textContent).toBe("2026-10-02");
    expect(doc.child(1).type.name).toBe("horizontalRule");
  });

  it("中英文默认模板都能通过真实 schema 校验", () => {
    for (const lang of ["zh-CN", "en-US"] as const) {
      const doc = buildDailyNoteDoc("2026-10-02", defaultDailyNotesConfig(lang).template, lang);
      expect(schema.nodeFromJSON(doc)).toBeTruthy();
    }
  });

  it("空模板时只有标题与分割线", () => {
    const doc = schema.nodeFromJSON(buildDailyNoteDoc("2026-10-02", "", "zh-CN"));
    expect(doc.childCount).toBe(2);
  });
});

describe("buildDailyFolderDoc", () => {
  it("首行 H1 = 目录名，说明段可省略", () => {
    const doc = schema.nodeFromJSON(buildDailyFolderDoc("每日笔记", "说明文字"));
    expect(doc.child(0).textContent).toBe("每日笔记");
    expect(doc.child(1).type.name).toBe("horizontalRule");
    expect(doc.childCount).toBe(3);

    expect(schema.nodeFromJSON(buildDailyFolderDoc("每日笔记", "")).childCount).toBe(2);
  });
});
