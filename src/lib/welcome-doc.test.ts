import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Highlight from "@tiptap/extension-highlight";
import { TextStyle } from "@tiptap/extension-text-style";
import Color from "@tiptap/extension-color";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableCell } from "@tiptap/extension-table-cell";
import { LockedHeading } from "@/features/editor/extensions/document-structure-lock";
import { CodeBlock } from "@/features/editor/extensions/code-block/index";
import { Math } from "@/features/editor/extensions/math/node";
import { Callout } from "@/features/editor/extensions/callout/node";
import { Toggle } from "@/features/editor/extensions/toggle/node";
import { buildWelcomeDoc, welcomeDocTitle, type WelcomeLang } from "./welcome-doc";

// 与 EditorPage 的注册保持一致（欢迎文档用到的节点/标记全覆盖），
// 用真实 TipTap schema 校验文档 JSON——防止首次启动写入内容后编辑器报 Invalid content。
const schema = getSchema([
  StarterKit.configure({
    link: { openOnClick: false, autolink: true },
    codeBlock: false,
    heading: false,
  }),
  LockedHeading.configure({ levels: [1, 2, 3] }),
  CodeBlock,
  Highlight.configure({ multicolor: true }),
  TextStyle,
  Color,
  TaskList,
  TaskItem.configure({ nested: true }),
  Table.configure({ resizable: true }),
  TableRow,
  TableHeader,
  TableCell,
  Math,
  Callout,
  Toggle,
]);

const LANGS: WelcomeLang[] = ["zh-CN", "en-US"];

const EXPECTED_NODES = [
  "paragraph",
  "heading",
  "horizontalRule",
  "bulletList",
  "orderedList",
  "taskList",
  "taskItem",
  "blockquote",
  "codeBlock",
  "callout",
  "toggle",
  "math",
  "table",
  "tableRow",
  "tableHeader",
  "tableCell",
];

const EXPECTED_MARKS = ["bold", "italic", "underline", "strike", "code", "highlight", "link", "textStyle"];

describe("welcomeDocTitle", () => {
  it("使用 TsFlowy 品牌名", () => {
    expect(welcomeDocTitle("zh-CN")).toBe("欢迎使用 TsFlowy");
    expect(welcomeDocTitle("en-US")).toBe("Welcome to TsFlowy");
  });
});

describe("buildWelcomeDoc", () => {
  it.each(LANGS)("%s：文档通过真实 schema 校验", (lang) => {
    // nodeFromJSON 在节点/标记/内容不合法时抛错（如 "Invalid content for node type"）
    expect(schema.nodeFromJSON(buildWelcomeDoc(lang))).toBeTruthy();
  });

  it.each(LANGS)("%s：首行 H1 标题与第二行分割线符合结构锁定", (lang) => {
    const doc = schema.nodeFromJSON(buildWelcomeDoc(lang));
    const first = doc.child(0);
    expect(first.type.name).toBe("heading");
    expect(first.attrs.level).toBe(1);
    expect(first.textContent).toBe(welcomeDocTitle(lang));
    expect(doc.child(1).type.name).toBe("horizontalRule");
  });

  it.each(LANGS)("%s：包含全部功能示例节点与标记", (lang) => {
    const doc = schema.nodeFromJSON(buildWelcomeDoc(lang));
    const nodeTypes = new Set<string>();
    const markTypes = new Set<string>();
    doc.descendants((node) => {
      nodeTypes.add(node.type.name);
      for (const mark of node.marks) markTypes.add(mark.type.name);
    });
    expect(EXPECTED_NODES.filter((t) => !nodeTypes.has(t))).toEqual([]);
    expect(EXPECTED_MARKS.filter((m) => !markTypes.has(m))).toEqual([]);
  });
});
