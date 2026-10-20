import { describe, expect, it } from "vitest";
import { Schema, Node as PMNode } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/core";
import { collectMatches, countReplaceableInDoc, replaceAllInDoc, scanMatches } from "./find-replace";

// 位置映射是这块逻辑唯一容易出错的地方：跨 mark、原子 inline 节点、多块文档
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    heading: { group: "block", content: "inline*", attrs: { level: { default: 1 } } },
    text: { group: "inline" },
    hardBreak: { inline: true, group: "inline" },
    image: { inline: true, group: "inline", attrs: { src: { default: "" }, alt: { default: "" } } },
    // 属性里带可见文本的原子块：查找要能搜到，替换一律不能碰（见 FindMatch.inAtom）
    math: { group: "block", atom: true, attrs: { tex: { default: "" } } },
    mermaid: { group: "block", atom: true, attrs: { code: { default: "" } } },
    attachment: { group: "block", atom: true, attrs: { name: { default: "" } } },
  },
  marks: { bold: {}, italic: {} },
});

const doc = (content: unknown) => PMNode.fromJSON(schema, { type: "doc", content });
const text = (value: string, marks?: { type: string }[]) => ({ type: "text", text: value, marks });

describe("collectMatches", () => {
  it("同一段落里的多处命中按出现顺序给出文档位置", () => {
    const d = doc([{ type: "paragraph", content: [text("hello world hello")] }]);
    expect(collectMatches(d, "hello")).toEqual([
      { from: 1, to: 6 },
      { from: 13, to: 18 },
    ]);
  });

  it("大小写不敏感", () => {
    const d = doc([{ type: "paragraph", content: [text("Hello HELLO")] }]);
    expect(collectMatches(d, "hello")).toEqual([
      { from: 1, to: 6 },
      { from: 7, to: 12 },
    ]);
  });

  it("跨 mark 的命中整段选中（粗体 + 普通文本）", () => {
    const d = doc([{ type: "paragraph", content: [text("he", [{ type: "bold" }]), text("llo world")] }]);
    expect(collectMatches(d, "hello")).toEqual([{ from: 1, to: 6 }]);
  });

  it("多块文档（标题 + 段落）各自在自己的位置上报", () => {
    const d = doc([
      { type: "heading", attrs: { level: 2 }, content: [text("标题 hello")] },
      { type: "paragraph", content: [text("正文 hello")] },
    ]);
    // 标题："标题 " 占 3 字符 → hello 从 1+3 起；标题块 nodeSize = 1+8+1 = 10，段落内容起点 11
    expect(collectMatches(d, "hello")).toEqual([
      { from: 4, to: 9 },
      { from: 14, to: 19 },
    ]);
  });

  it("原子 inline 节点以占位符参与匹配，不再产生跨原子的假命中", () => {
    const d = doc([{ type: "paragraph", content: [text("ab"), { type: "hardBreak" }, text("cd")] }]);
    // 段落内容起点 1：a=1 b=2 换行=3 c=4 d=5
    expect(collectMatches(d, "cd")).toEqual([{ from: 4, to: 6 }]);
    // hardBreak 占一个字符位：跨它的 "abcd" 不再误命中（旧实现按 textContent 拼接会命中）
    expect(collectMatches(d, "abcd")).toEqual([]);
    // 非文本 atom（image，leaf nodeSize=1）同样以占位符隔离：a=1 b=2 image=3 c=4 d=5
    const d2 = doc([{ type: "paragraph", content: [text("ab"), { type: "image", attrs: { src: "x" } }, text("cd")] }]);
    expect(collectMatches(d2, "abcd")).toEqual([]);
    expect(collectMatches(d2, "cd")).toEqual([{ from: 4, to: 6 }]);
  });

  it("查询词含 \\n 时可跨块匹配，块边界映射到兄弟块起始位", () => {
    const d = doc([
      { type: "paragraph", content: [text("foo bar")] },
      { type: "paragraph", content: [text("baz")] },
    ]);
    // 首块 nodeSize=9 → 次块起始 pos 9；"bar\nbaz" = 5..7 + 边界 9 + 10..12
    expect(collectMatches(d, "bar\nbaz")).toEqual([{ from: 5, to: 13 }]);
  });

  it("相邻块的尾首文本不会被拼接成跨块假命中", () => {
    const d = doc([
      { type: "paragraph", content: [text("ab")] },
      { type: "paragraph", content: [text("cd")] },
    ]);
    expect(collectMatches(d, "abcd")).toEqual([]);
  });

  it("空查询与无命中都返回空数组", () => {
    const d = doc([{ type: "paragraph", content: [text("abc")] }]);
    expect(collectMatches(d, "")).toEqual([]);
    expect(collectMatches(d, "zzz")).toEqual([]);
  });
});

describe("原子块属性文本（公式源码 / Mermaid / 附件名 / 图片 alt）", () => {
  const math = (tex: string) => ({ type: "math", attrs: { tex } });
  const mermaid = (code: string) => ({ type: "mermaid", attrs: { code } });
  const attachment = (name: string) => ({ type: "attachment", attrs: { name } });
  const para = (value: string) => ({ type: "paragraph", content: [text(value)] });

  it("正文搜不到的属性文本现在能命中，并映射回节点自身范围", () => {
    // 单个 math 块：leaf nodeSize=1，节点位置 0；占位符 + 「\alpha beta」都映射到 0
    const d = doc([math("\\alpha beta")]);
    expect(collectMatches(d, "alpha")).toEqual([{ from: 0, to: 1, inAtom: true }]);
    expect(collectMatches(d, "lpha be")).toEqual([{ from: 0, to: 1, inAtom: true }]);
    expect(collectMatches(d, "gamma")).toEqual([]);
  });

  it("几种原子块各有各的属性字段", () => {
    // 段落「正文」占 1..2，nodeSize=4 → mermaid 在 pos 4；再 +1 → attachment 在 pos 5
    const d = doc([para("正文"), mermaid("graph TD"), attachment("报价单.pdf")]);
    expect(scanMatches(d, "graph TD").matches).toEqual([{ from: 4, to: 5, inAtom: true }]);
    expect(scanMatches(d, "报价单").matches).toEqual([{ from: 5, to: 6, inAtom: true }]);
    // 正文命中照旧，不带 inAtom
    expect(scanMatches(d, "正文").matches).toEqual([{ from: 1, to: 3 }]);
  });

  it("属性文本与正文之间的边界不允许被命中跨越", () => {
    // 段落「ab」= 1,2；image 紧跟其后落在 pos 3，alt「cd」也映射到 3
    const d = doc([{ type: "paragraph", content: [text("ab"), { type: "image", attrs: { alt: "cd" } }] }]);
    expect(collectMatches(d, "ab")).toEqual([{ from: 1, to: 3 }]);
    expect(collectMatches(d, "cd")).toEqual([{ from: 3, to: 4, inAtom: true }]);
    // 「bcd」半在正文半在属性里：按正文替换会把图片整个吃掉，所以这条根本不算命中
    expect(collectMatches(d, "bcd")).toEqual([]);
  });

  it("跨块的查询不会从属性文本里穿出去", () => {
    const d = doc([{ type: "image", attrs: { alt: "cd" } }, para("ef")]);
    expect(collectMatches(d, "d\ne")).toEqual([]);
  });

  it("正则档同样识别属性文本命中", () => {
    const d = doc([math("E = mc^2")]);
    expect(scanMatches(d, "mc.2", { regex: true }).matches).toEqual([{ from: 0, to: 1, inAtom: true }]);
  });
});

describe("scanMatches 匹配选项（区分大小写 / 全词）", () => {
  it("caseSensitive：只有大小写完全一致才命中，默认仍不敏感", () => {
    const d = doc([{ type: "paragraph", content: [text("Hello HELLO hello")] }]);
    expect(scanMatches(d, "hello", { caseSensitive: true }).matches).toEqual([{ from: 13, to: 18 }]);
    expect(scanMatches(d, "hello").matches).toHaveLength(3);
  });

  it("wholeWord：拉丁词/数字受边界约束", () => {
    const d = doc([{ type: "paragraph", content: [text("the there other 123 a123")] }]);
    // "the" 独立命中；"there"（后接词字符）与 "other"（前接词字符）不算全词
    expect(scanMatches(d, "the", { wholeWord: true }).matches).toEqual([{ from: 1, to: 4 }]);
    // "123" 独立命中；"a123" 中前接 a 不命中
    expect(scanMatches(d, "123", { wholeWord: true }).matches).toEqual([{ from: 17, to: 20 }]);
  });

  it("wholeWord 对中日韩文本不生效：CJK 视为非词字符", () => {
    const d = doc([{ type: "paragraph", content: [text("这是一个测试文本")] }]);
    expect(scanMatches(d, "测试", { wholeWord: true }).matches).toEqual([{ from: 5, to: 7 }]);
    // 汉字紧邻的拉丁词同样命中：全词只按拉丁词字符判边界
    const d2 = doc([{ type: "paragraph", content: [text("测试test中文")] }]);
    expect(scanMatches(d2, "test", { wholeWord: true }).matches).toEqual([{ from: 3, to: 7 }]);
  });

  it("wholeWord + caseSensitive 组合", () => {
    const d = doc([{ type: "paragraph", content: [text("The THE then")] }]);
    expect(scanMatches(d, "THE", { caseSensitive: true, wholeWord: true }).matches).toEqual([{ from: 5, to: 8 }]);
  });

  it("wholeWord 边界跨 mark 仍按拼接文本判定", () => {
    const d = doc([{ type: "paragraph", content: [text("hel", [{ type: "bold" }]), text("lo world")] }]);
    // "hel" 后接词字符 l → 不构成全词；"hello" 整体后接空格 → 命中
    expect(scanMatches(d, "hel", { wholeWord: true }).matches).toEqual([]);
    expect(scanMatches(d, "hello", { wholeWord: true }).matches).toEqual([{ from: 1, to: 6 }]);
  });

  it("wholeWord 下块边界（拼接分隔符 \\n）不阻断命中", () => {
    const d = doc([
      { type: "paragraph", content: [text("the")] },
      { type: "paragraph", content: [text("them")] },
    ]);
    expect(scanMatches(d, "the", { wholeWord: true }).matches).toEqual([{ from: 1, to: 4 }]);
  });
});

describe("scanMatches 正则档", () => {
  it("默认不区分大小写，caseSensitive 才收紧", () => {
    const d = doc([{ type: "paragraph", content: [text("Hello HELLO hillo")] }]);
    expect(scanMatches(d, "h.llo", { regex: true }).matches).toEqual([
      { from: 1, to: 6 },
      { from: 7, to: 12 },
      { from: 13, to: 18 },
    ]);
    expect(scanMatches(d, "h.llo", { regex: true, caseSensitive: true }).matches).toEqual([{ from: 13, to: 18 }]);
  });

  it("正则元字符只在正则档生效，全文档一律当字面量", () => {
    const d = doc([{ type: "paragraph", content: [text("abc 订单 12345 号")] }]);
    expect(scanMatches(d, "a.c", { regex: true }).matches).toEqual([{ from: 1, to: 4 }]);
    expect(scanMatches(d, "\\d+", { regex: true }).matches).toEqual([{ from: 8, to: 13 }]);
    expect(scanMatches(d, "a.c").matches).toEqual([]);
    expect(scanMatches(d, "\\d+").matches).toEqual([]);
  });

  it("命中跨 mark 时按拼接索引映射回整段位置", () => {
    const d = doc([{ type: "paragraph", content: [text("20", [{ type: "bold" }]), text("26-10")] }]);
    expect(scanMatches(d, "\\d{4}-\\d{2}", { regex: true }).matches).toEqual([{ from: 1, to: 8 }]);
  });

  it("零宽命中（x*、^ 一类）不进结果也不会死循环", () => {
    const d = doc([{ type: "paragraph", content: [text("axxb")] }]);
    expect(scanMatches(d, "x*", { regex: true }).matches).toEqual([{ from: 2, to: 4 }]);
    expect(scanMatches(d, "^", { regex: true }).matches).toEqual([]);
  });

  it("wholeWord 在正则档同样生效", () => {
    const d = doc([{ type: "paragraph", content: [text("the there")] }]);
    expect(scanMatches(d, "the", { regex: true, wholeWord: true }).matches).toEqual([{ from: 1, to: 4 }]);
  });

  it("非法表达式返回 invalid，不与「没有命中」混为一谈", () => {
    const d = doc([{ type: "paragraph", content: [text("hello")] }]);
    expect(scanMatches(d, "(未闭合", { regex: true })).toEqual({ matches: [], truncated: false, invalid: true });
    expect(scanMatches(d, "zzz", { regex: true })).toEqual({ matches: [], truncated: false, invalid: false });
  });

  it("触顶时 truncated 与全文扫描口径一致", () => {
    const d = doc([{ type: "paragraph", content: [text("a".repeat(1001))] }]);
    expect(scanMatches(d, "a", { regex: true }).matches).toHaveLength(1000);
    expect(scanMatches(d, "a", { regex: true }).truncated).toBe(true);
  });
});

/**
 * 全局替换走编辑器事务这条路需要一个真 Editor，而这里只用到 state / view.dispatch 三个成员，
 * 于是拿同一份 schema 造个会随事务推进的替身：既能在 node 环境跑，也保证断言的是真实位置计算。
 */
function fakeEditor(d: PMNode) {
  let state = EditorState.create({ doc: d, schema });
  const editor = {
    isDestroyed: false,
    get state() {
      return state;
    },
    view: {
      dispatch: (tr: Parameters<typeof state.apply>[0]) => {
        state = state.apply(tr);
      },
    },
  } as unknown as Editor;
  return { editor, docOf: () => state.doc };
}

describe("replaceAllInDoc（全局替换的编辑器路径）", () => {
  const para = (value: string) => ({ type: "paragraph", content: [text(value)] });

  it("换掉段内全部命中，并按事务落到文档里", () => {
    const { editor, docOf } = fakeEditor(doc([para("旧名 与 旧名"), para("再来一个旧名")]));
    expect(replaceAllInDoc(editor, "旧名", "新名")).toBe(3);
    expect(docOf().textContent).toBe("新名 与 新名再来一个新名");
  });

  it("首个标题块是页面标题，保护区内的命中一个字都不动", () => {
    const { editor, docOf } = fakeEditor(doc([{ type: "heading", content: [text("旧名指南")] }, para("正文里的旧名")]));
    expect(replaceAllInDoc(editor, "旧名", "新名")).toBe(1);
    expect(docOf().child(0).textContent).toBe("旧名指南");
    expect(docOf().child(1).textContent).toBe("正文里的新名");
  });

  it("跨 mark 的命中也能替换（这是 JSON 层批量替换刻意不覆盖的部分）", () => {
    const { editor, docOf } = fakeEditor(
      doc([{ type: "paragraph", content: [text("前端", [{ type: "bold" }]), text("框架 后端")] }]),
    );
    expect(replaceAllInDoc(editor, "前端框架", "全栈")).toBe(1);
    expect(docOf().textContent).toBe("全栈 后端");
  });

  it("替换串为空即删除命中；预览计数与实际替换处数同一口径", () => {
    const { editor, docOf } = fakeEditor(doc([para("a-b-c")]));
    expect(countReplaceableInDoc(editor, "-")).toBe(2);
    expect(replaceAllInDoc(editor, "-", "")).toBe(2);
    expect(docOf().textContent).toBe("abc");
  });

  it("没有命中返回 0 且不产生事务", () => {
    const { editor, docOf } = fakeEditor(doc([para("正文")]));
    expect(replaceAllInDoc(editor, "旧名", "新名")).toBe(0);
    expect(countReplaceableInDoc(editor, "旧名")).toBe(0);
    expect(docOf().textContent).toBe("正文");
  });

  it("替换串里本就含查询词时只跑一轮，不会越替换越多", () => {
    const { editor, docOf } = fakeEditor(doc([para("旧名")]));
    expect(replaceAllInDoc(editor, "旧名", "旧名旧名")).toBe(1);
    expect(docOf().textContent).toBe("旧名旧名");
  });

  it("属性文本里的同名文字不算可替换：预览计数与实际处数同一口径", () => {
    // 段落 nodeSize = 1+5+1 = 7 → math 在 pos 7
    const { editor, docOf } = fakeEditor(doc([para("旧名 正文"), { type: "math", attrs: { tex: "旧名公式" } }]));
    expect(countReplaceableInDoc(editor, "旧名")).toBe(1);
    expect(replaceAllInDoc(editor, "旧名", "新名")).toBe(1);
    expect(docOf().child(0).textContent).toBe("新名 正文");
    expect(docOf().child(1).attrs.tex).toBe("旧名公式");
  });
});
