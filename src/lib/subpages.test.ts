import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import type { JSONContent } from "@tiptap/core";
import { LockedHeading } from "@/features/editor/extensions/document-structure-lock";
import { Subpages } from "@/features/editor/extensions/subpages/node";
import { readSubpagesItems, subpagesAnchorIndex, upsertSubpagesNode, type SubpageItem } from "./subpages";

// 与 EditorPage 注册一致：用真实 schema 校验生成的文档 JSON，
// 防插入子页面块后编辑器报 Invalid content
const schema = getSchema([
  StarterKit.configure({ heading: false }),
  LockedHeading.configure({ levels: [1, 2, 3] }),
  Subpages,
]);

const h1 = (text: string): JSONContent => ({ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text }] });
const para = (text: string): JSONContent => ({ type: "paragraph", content: [{ type: "text", text }] });

const docWithHeader = (): JSONContent => ({
  type: "doc",
  content: [h1("父页面"), { type: "horizontalRule" }, para("正文")],
});

const A: SubpageItem = { id: "v-a", name: "子页面 A" };
const B: SubpageItem = { id: "v-b", name: "子页面 B" };

describe("subpagesAnchorIndex", () => {
  it("首行 H1 + 分割线 → 2", () => {
    expect(subpagesAnchorIndex(docWithHeader().content!)).toBe(2);
  });

  it("首行 H1 无分割线 → 1", () => {
    expect(subpagesAnchorIndex([h1("标题"), para("正文")])).toBe(1);
  });

  it("首行不是 H1 / 空文档 → -1", () => {
    expect(subpagesAnchorIndex([para("正文")])).toBe(-1);
    expect(subpagesAnchorIndex([])).toBe(-1);
  });
});

describe("upsertSubpagesNode", () => {
  it("插入到 H1 + 分割线之后，且通过真实 schema 校验", () => {
    const next = upsertSubpagesNode(docWithHeader(), [A, B]);
    expect(next.content!.map((n) => n.type)).toEqual(["heading", "horizontalRule", "subpages", "paragraph"]);
    expect(readSubpagesItems(next)).toEqual([A, B]);
    expect(() => schema.nodeFromJSON(next)).not.toThrow();
  });

  it("已有块时整体替换，全篇只保留一个", () => {
    const once = upsertSubpagesNode(docWithHeader(), [A]);
    const twice = upsertSubpagesNode(once, [B]);
    expect(twice.content!.filter((n) => n.type === "subpages")).toHaveLength(1);
    expect(readSubpagesItems(twice)).toEqual([B]);
    // 正文保留
    expect(twice.content!.some((n) => n.type === "paragraph")).toBe(true);
  });

  it("items 为空时移除已有块", () => {
    const once = upsertSubpagesNode(docWithHeader(), [A]);
    const cleared = upsertSubpagesNode(once, []);
    expect(cleared.content!.some((n) => n.type === "subpages")).toBe(false);
    expect(cleared.content!.length).toBe(3);
  });

  it("没有首行 H1 的文档原样返回（同一个引用）", () => {
    const doc: JSONContent = { type: "doc", content: [para("正文")] };
    expect(upsertSubpagesNode(doc, [A])).toBe(doc);
  });

  it("内容无变化时返回同一个引用（供调用方跳过落库）", () => {
    const once = upsertSubpagesNode(docWithHeader(), [A]);
    expect(upsertSubpagesNode(once, [A])).toBe(once);
  });

  it("空 items 且本来就没有块时返回同一个引用", () => {
    const doc = docWithHeader();
    expect(upsertSubpagesNode(doc, [])).toBe(doc);
  });

  it("readSubpagesItems 对损坏数据返回空数组", () => {
    expect(readSubpagesItems({ type: "doc", content: [] })).toEqual([]);
    expect(readSubpagesItems({ type: "doc", content: [{ type: "subpages", attrs: { items: "bad" } }] })).toEqual([]);
  });
});
