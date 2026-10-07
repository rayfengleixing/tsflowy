import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { buildPageTemplate, findPageTemplate, PAGE_TEMPLATES } from "./page-templates";

// 与 EditorPage 用到的节点保持一致（模板只涉及这些基础块），
// 用真实 TipTap schema 校验 JSON，防止落库后编辑器报 Invalid content。
const schema = getSchema([StarterKit.configure({ codeBlock: false }), TaskList, TaskItem.configure({ nested: true })]);

const LANGS = ["zh-CN", "en-US"] as const;

describe("buildPageTemplate", () => {
  it("未知模板返回 null", () => {
    expect(buildPageTemplate("nope", "标题", "zh-CN")).toBeNull();
  });

  it("首行是 H1（=页面名）、第二行是分割线", () => {
    const doc = buildPageTemplate("meeting", "周一例会", "zh-CN")!;
    const content = doc.content ?? [];
    expect(content[0]).toMatchObject({ type: "heading", attrs: { level: 1 } });
    expect((content[0].content?.[0] as { text: string }).text).toBe("周一例会");
    expect(content[1]).toMatchObject({ type: "horizontalRule" });
    expect(content.length).toBeGreaterThan(2);
  });

  it("每种模板 × 每种语言都产出合法 TipTap 文档", () => {
    for (const tpl of PAGE_TEMPLATES) {
      for (const lang of LANGS) {
        const doc = buildPageTemplate(tpl.id, "标题", lang);
        expect(doc).not.toBeNull();
        expect(() => schema.nodeFromJSON(doc!)).not.toThrow();
      }
    }
  });

  it("中英文模板正文不同（确有本地化）", () => {
    for (const tpl of PAGE_TEMPLATES) {
      const zh = buildPageTemplate(tpl.id, "标题", "zh-CN")!;
      const en = buildPageTemplate(tpl.id, "标题", "en-US")!;
      expect(JSON.stringify(zh)).not.toBe(JSON.stringify(en));
    }
  });

  it("findPageTemplate 按 id 取模板", () => {
    expect(findPageTemplate("weekly")?.nameKey).toBe("template.weekly");
    expect(findPageTemplate("missing")).toBeUndefined();
  });
});
