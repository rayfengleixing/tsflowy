import { describe, expect, it } from "vitest";
import { citationHref, citationViewId, splitCitations, transformCitations, type CitationNode } from "@/lib/ai-citation";

const resolveKnown = (id: string) => (id === "abc" || id === "def" ? `页面-${id}` : null);

describe("ai-citation 文本切分", () => {
  it("命中的引用换成链接节点，前后文本各自成段", () => {
    expect(splitCitations("见 [id=abc] 与 [id=def] 两处", resolveKnown)).toEqual([
      { type: "text", value: "见 " },
      { type: "link", url: citationHref("abc"), children: [{ type: "text", value: "页面-abc" }] },
      { type: "text", value: " 与 " },
      { type: "link", url: citationHref("def"), children: [{ type: "text", value: "页面-def" }] },
      { type: "text", value: " 两处" },
    ]);
  });

  it("解析不到的 id 原样留着，不造点不动的假链接", () => {
    expect(splitCitations("见 [id=zzz]", resolveKnown)).toEqual([{ type: "text", value: "见 [id=zzz]" }]);
    // 同一段里一半能解析：能的那半照旧变链接，不能的那半留在尾巴文本里
    expect(splitCitations("[id=abc] x [id=zzz]", resolveKnown)).toEqual([
      { type: "link", url: citationHref("abc"), children: [{ type: "text", value: "页面-abc" }] },
      { type: "text", value: " x [id=zzz]" },
    ]);
  });

  it("脏 id 不认：引号、空白、超长都会把选择器/树查抄坏，宁可不转", () => {
    expect(splitCitations('[id=a"b]', () => "标题")).toEqual([{ type: "text", value: '[id=a"b]' }]);
    expect(splitCitations("[id=a b]", () => "标题")).toEqual([{ type: "text", value: "[id=a b]" }]);
    expect(splitCitations(`[id=${"x".repeat(65)}]`, () => "标题")).toHaveLength(1);
  });
});

describe("ai-citation 子树改写", () => {
  it("只碰 text 节点：代码与行内代码里的同样子串不动", () => {
    const tree: CitationNode = {
      type: "root",
      children: [
        { type: "code", value: "console.log('[id=abc]')" },
        { type: "paragraph", children: [{ type: "inlineCode", value: "[id=abc]" }] },
        { type: "paragraph", children: [{ type: "text", value: "引用 [id=abc]" }] },
      ],
    };
    transformCitations(tree, resolveKnown);
    expect(tree.children?.[0]).toEqual({ type: "code", value: "console.log('[id=abc]')" });
    expect(tree.children?.[1]?.children?.[0]).toEqual({ type: "inlineCode", value: "[id=abc]" });
    expect(tree.children?.[2]?.children?.[1]).toMatchObject({ type: "link", url: citationHref("abc") });
  });

  it("嵌套容器（引用块里的段落）同样改写", () => {
    const tree: CitationNode = {
      type: "root",
      children: [
        { type: "blockquote", children: [{ type: "paragraph", children: [{ type: "text", value: "[id=abc]" }] }] },
      ],
    };
    transformCitations(tree, resolveKnown);
    const inner = tree.children?.[0]?.children?.[0]?.children?.[0];
    expect(inner).toMatchObject({ type: "link", url: citationHref("abc") });
  });
});

describe("ai-citation href 还原", () => {
  it("只认本站引用前缀与 uuid 形态的 id", () => {
    expect(citationViewId(citationHref("abc"))).toBe("abc");
    expect(citationViewId("other/abc")).toBeNull();
    expect(citationViewId(`${citationHref("")}`)).toBeNull();
    expect(citationViewId(`tsflowy-citation/a"b`)).toBeNull();
  });
});
