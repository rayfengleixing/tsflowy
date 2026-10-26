import { describe, expect, it } from "vitest";
import { MATH_CLASS_BLOCK, MATH_CLASS_INLINE, splitMath, transformMath, type MathNode } from "./ai-math";

const inline = (tex: string): MathNode => ({
  type: "aiMath",
  data: { hName: "span", hProperties: { className: MATH_CLASS_INLINE } },
  children: [{ type: "text", value: tex }],
});
const block = (tex: string): MathNode => ({
  type: "aiMath",
  data: { hName: "span", hProperties: { className: MATH_CLASS_BLOCK } },
  children: [{ type: "text", value: tex }],
});
const text = (value: string): MathNode => ({ type: "text", value });

describe("ai-math 行内公式切分", () => {
  it("命中前后文本各自成段", () => {
    expect(splitMath("面积 $S = \\pi r^2$ 已知")).toEqual([text("面积 "), inline("S = \\pi r^2"), text(" 已知")]);
  });

  it("同一段里多处公式逐个换", () => {
    expect(splitMath("$a$ and $b$")).toEqual([inline("a"), text(" and "), inline("b")]);
  });

  it("金额不算公式：$ 后紧跟空白、闭合 $ 前是空白、闭合 $ 后是数字都挡下", () => {
    expect(splitMath("要 $100 和 $200")).toEqual([text("要 $100 和 $200")]);
    expect(splitMath("$ a$ 与 $b $")).toEqual([text("$ a$ 与 $b $")]);
    expect(splitMath("5$ 到 10$")).toEqual([text("5$ 到 10$")]);
  });

  it("闭合 $ 后紧跟数字不算公式（只有这一条挡得住 `$x$2`）", () => {
    expect(splitMath("共 $x$2 个")).toEqual([text("共 $x$2 个")]);
  });

  it("内容为空或纯空白不当公式", () => {
    expect(splitMath("$$$$")).toEqual([text("$$$$")]);
    expect(splitMath("$ $")).toEqual([text("$ $")]);
  });

  it("行内公式不跨行", () => {
    expect(splitMath("$a\nb$")).toEqual([text("$a\nb$")]);
  });
});

describe("ai-math 块级公式切分", () => {
  it("$$…$$ 可以跨行", () => {
    expect(splitMath("$$\n\\frac{a}{b}\n$$")).toEqual([block("\n\\frac{a}{b}\n")]);
  });

  it("块级命中后，剩余文本里的行内公式照旧处理", () => {
    expect(splitMath("先看 $$x^2$$ 再看 $y^2$")).toEqual([text("先看 "), block("x^2"), text(" 再看 "), inline("y^2")]);
  });

  it("成对的 $$ 不会被行内规则拆成半截", () => {
    expect(splitMath("$$a+b$$")).toEqual([block("a+b")]);
  });
});

describe("ai-math 子树改写", () => {
  it("只碰 text 节点：代码块与行内代码里的 $ 不动", () => {
    const tree: MathNode = {
      type: "root",
      children: [
        { type: "code", value: "const a = `$x$`" },
        { type: "paragraph", children: [{ type: "inlineCode", value: "$x$" }] },
        { type: "paragraph", children: [{ type: "text", value: "公式 $x$" }] },
      ],
    };
    transformMath(tree);
    expect(tree.children?.[0]).toEqual({ type: "code", value: "const a = `$x$`" });
    expect(tree.children?.[1]?.children?.[0]).toEqual({ type: "inlineCode", value: "$x$" });
    expect(tree.children?.[2]?.children?.[1]).toMatchObject({ type: "aiMath" });
  });

  it("没有 $ 的节点原样保留，容器嵌套照样下钻", () => {
    const tree: MathNode = {
      type: "root",
      children: [{ type: "blockquote", children: [{ type: "paragraph", children: [{ type: "text", value: "$x$" }] }] }],
    };
    transformMath(tree);
    expect(tree.children?.[0]?.children?.[0]?.children?.[0]).toMatchObject({ type: "aiMath" });
  });
});
