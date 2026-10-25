// AI 桥接从 EditorPage 的 useEffect 里切出来时是「搬不改」，但搬出来的那一刻它第一次能被单独驱动：
// 锚点定位、保护区守卫、回填格式、撤销试探这四组分支，原来只能靠原生窗口里点 AI 面板验。
// 夹具用真 schema + 真 EditorState + prosemirror-history，只把 DOM 侧的 view 换成记账用的假件。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSchema, type JSONContent, type Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Node as PMNode } from "@tiptap/pm/model";
import { EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import { history, redo, undo } from "@tiptap/pm/history";

import { createAiEditorBridge } from "./ai-bridge";
import { STRUCTURE_SYNC_META } from "./extensions/document-structure-lock";

vi.mock("@/lib/i18n", () => ({
  t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
}));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

const schema = getSchema([StarterKit]);

/** 真文档的真实结构：首行 H1 + 第二行分割线（由结构锁定保证），桥接的 index===0 守卫认的就是这一行 */
const pageDoc = (title: string, ...rest: JSONContent[]): JSONContent => ({
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: title }] },
    { type: "horizontalRule" },
    ...rest,
  ],
});

const para = (text: string): JSONContent => ({ type: "paragraph", content: [{ type: "text", text }] });
const section = (heading: string, ...body: JSONContent[]): JSONContent[] => [
  { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: heading }] },
  ...body,
];

interface Harness {
  editor: Editor;
  state: () => EditorState;
  docJson: () => JSONContent;
  /** 假 view 收到的事务，供断言 STRUCTURE_SYNC_META 这类元信息 */
  dispatched: () => Transaction[];
  /** 在光标处打一次字（独立事务，会进撤销栈，用来模拟「AI 改完用户又编辑」） */
  type: (text: string) => void;
  select: (from: number, to: number) => void;
  focusCalls: () => number;
  destroy: () => void;
}

function makeEditor(doc: JSONContent, opts: { redoFails?: boolean } = {}): Harness {
  let state = EditorState.create({
    schema,
    doc: PMNode.fromJSON(schema, doc),
    plugins: [history()],
  });
  const sent: Transaction[] = [];
  const dispatch = (tr: Transaction) => {
    sent.push(tr);
    state = state.apply(tr);
  };
  let focusCalls = 0;
  const editor = {
    get state() {
      return state;
    },
    isDestroyed: false,
    view: { dispatch, focus: () => (focusCalls += 1) },
    commands: {
      undo: () => undo(state, dispatch),
      redo: () => (opts.redoFails ? false : redo(state, dispatch)),
    },
  };
  return {
    editor: editor as unknown as Editor,
    state: () => state,
    docJson: () => state.doc.toJSON() as JSONContent,
    dispatched: () => sent,
    type: (text) => dispatch(state.tr.insertText(text, state.selection.from)),
    select: (from, to) => dispatch(state.tr.setSelection(TextSelection.create(state.doc, from, to))),
    focusCalls: () => focusCalls,
    destroy: () => {
      editor.isDestroyed = true;
    },
  };
}

/** 末元素（tsconfig 的 lib 里没有 Array.prototype.at） */
function last<T>(arr: T[]): T | undefined {
  return arr[arr.length - 1];
}

/** 顶层块列表（含绝对起止位置），断言插入落点时比数坐标清楚 */
const topBlocks = (h: Harness) => {
  const out: { type: string; text: string; from: number; to: number }[] = [];
  let pos = 0;
  h.state().doc.forEach((node) => {
    out.push({ type: node.type.name, text: node.textContent, from: pos, to: pos + node.nodeSize });
    pos += node.nodeSize;
  });
  return out;
};

/** 正文第一段（跳过 H1 与分割线）的起始位置，用来摆选区 */
const firstParagraphFrom = (h: Harness) => topBlocks(h)[2].from + 1;

describe("读取侧：整页文本、标题、选区", () => {
  const h = makeEditor({ type: "doc", content: [para("第一段"), para("第二段")] });
  const bridge = createAiEditorBridge({ editor: h.editor, viewName: "页面标题" });

  it("getPageText 用换行连接顶层块", () => {
    expect(bridge.getPageText()).toBe("第一段\n第二段");
  });

  it("getPageTitle 取宿主传进来的 viewName", () => {
    expect(bridge.getPageTitle()).toBe("页面标题");
  });

  it("getSelectionText：未选中为空串，选中后只给选中文本", () => {
    expect(bridge.getSelectionText()).toBe("");
    // 第一段「第一段」的正文占 1..4，选 2..4 即「一段」
    h.select(2, 4);
    expect(bridge.getSelectionText()).toBe("一段");
  });

  it("编辑器已销毁时三条读取都返回空串", () => {
    const dead = makeEditor({ type: "doc", content: [para("甲")] });
    const deadBridge = createAiEditorBridge({ editor: dead.editor, viewName: "标题" });
    dead.destroy();
    expect(deadBridge.getPageText()).toBe("");
    expect(deadBridge.getPageTitle()).toBe("");
    expect(deadBridge.getSelectionText()).toBe("");
    expect(deadBridge.getEditTargetText("replace_selection")).toBe("");
    expect(deadBridge.applyEdit("append_to_document", "内容").applied).toBe(false);
    deadBridge.replaceSelection("内容");
    deadBridge.insertAtCursor("内容");
    expect(dead.dispatched()).toEqual([]);
    expect(deadBridge.undoAiEdit({ before: dead.docJson() })).toBe(false);
  });
});

describe("回填侧：markdown 走结构化、纯文本按行拆段", () => {
  it("replaceSelection 把选区换成带结构的块", () => {
    const h = makeEditor(pageDoc("标题", para("选中这段")));
    const bridge = createAiEditorBridge({ editor: h.editor, viewName: "标题" });
    const blocks = topBlocks(h);
    h.select(blocks[2].from + 1, blocks[2].to - 1);
    bridge.replaceSelection("# 小结\n- 甲\n- 乙");
    const after = topBlocks(h);
    expect(after.map((b) => b.type)).toEqual(["heading", "horizontalRule", "heading", "bulletList"]);
    expect(after[3].text).toBe("甲乙");
    expect(h.focusCalls()).toBe(1);
  });

  it("insertAtCursor 收到纯文本时按行拆成多个段落，不合并成一行", () => {
    const h = makeEditor(pageDoc("标题", para("原文")));
    const bridge = createAiEditorBridge({ editor: h.editor, viewName: "标题" });
    h.select(firstParagraphFrom(h), firstParagraphFrom(h));
    bridge.insertAtCursor("甲行\n乙行");
    const after = topBlocks(h);
    expect(after.map((b) => b.text)).toEqual(["标题", "", "甲行", "乙行", "原文"]);
  });

  // mention 节点不在夹具 schema 里（真编辑器注册了它），fromJSON 抛错 → toSlice 返回 null，
  // 正好用来走「转换失败」那条退化分支
  const unconvertible = "参考 @[报表](view:123)";

  it("replaceSelection 在转换失败时退化为纯文本插入（宁可丢格式也不要什么都不发生）", () => {
    const h = makeEditor(pageDoc("标题", para("原文")));
    const bridge = createAiEditorBridge({ editor: h.editor, viewName: "标题" });
    const blocks = topBlocks(h);
    h.select(blocks[2].from + 1, blocks[2].to - 1);
    bridge.replaceSelection(unconvertible);
    expect(last(topBlocks(h))?.text).toBe(unconvertible);
  });

  it("insertAtCursor 在转换失败时同样退化为纯文本插入", () => {
    const h = makeEditor(pageDoc("标题", para("原文")));
    const bridge = createAiEditorBridge({ editor: h.editor, viewName: "标题" });
    h.select(firstParagraphFrom(h), firstParagraphFrom(h));
    bridge.insertAtCursor(unconvertible);
    expect(topBlocks(h)[2].text).toBe(unconvertible + "原文");
  });

  it("applyEdit 在转换失败时回报未落地，文档一字未动", () => {
    const h = makeEditor(pageDoc("标题", para("原文")));
    const bridge = createAiEditorBridge({ editor: h.editor, viewName: "标题" });
    const before = h.docJson();
    expect(bridge.applyEdit("append_to_document", unconvertible)).toEqual({ applied: false });
    expect(h.docJson()).toEqual(before);
  });
});

describe("定位侧：getEditTargetText 给出即将改动的原文", () => {
  const build = () =>
    makeEditor(
      pageDoc(
        "页名",
        ...section("小节甲", para("小节甲的第一段"), para("小节甲的第二段")),
        ...section("小节乙", para("要替换的文字")),
      ),
    );

  it("replace_text 命中时给出命中的原文", () => {
    const h = build();
    const bridge = createAiEditorBridge({ editor: h.editor, viewName: "页名" });
    expect(bridge.getEditTargetText("replace_text", { text: "替换的文字" })).toBe("替换的文字");
  });

  it("replace_text 没命中时为空串（预览不该显示一个不存在的原文）", () => {
    const h = build();
    const bridge = createAiEditorBridge({ editor: h.editor, viewName: "页名" });
    expect(bridge.getEditTargetText("replace_text", { text: "不存在" })).toBe("");
    expect(bridge.getEditTargetText("replace_text")).toBe("");
  });

  it("replace_under_heading 给出该小节（到下一个同级标题之前）的全部内容", () => {
    const h = build();
    const bridge = createAiEditorBridge({ editor: h.editor, viewName: "页名" });
    expect(bridge.getEditTargetText("replace_under_heading", { heading: "小节甲" })).toBe(
      "小节甲的第一段\n小节甲的第二段",
    );
    // 最后一个同级小节吃到文档结尾
    expect(bridge.getEditTargetText("replace_under_heading", { heading: "小节乙" })).toBe("要替换的文字");
    expect(bridge.getEditTargetText("replace_under_heading", { heading: "查无此节" })).toBe("");
  });

  it("锚点带 markdown 记号也能定位（标题文本按去记号后的口径比）", () => {
    const h = build();
    const bridge = createAiEditorBridge({ editor: h.editor, viewName: "页名" });
    expect(bridge.getEditTargetText("replace_under_heading", { heading: "## 小节甲**" })).toBe(
      "小节甲的第一段\n小节甲的第二段",
    );
  });

  it("插入/追加类没有被覆盖的原文，一律空串", () => {
    const h = build();
    const bridge = createAiEditorBridge({ editor: h.editor, viewName: "页名" });
    expect(bridge.getEditTargetText("insert_under_heading", { heading: "小节甲" })).toBe("");
    expect(bridge.getEditTargetText("append_to_document")).toBe("");
    expect(bridge.getEditTargetText("insert_at_cursor")).toBe("");
  });

  it("replace_selection 未选中时空串", () => {
    const h = build();
    const bridge = createAiEditorBridge({ editor: h.editor, viewName: "页名" });
    expect(bridge.getEditTargetText("replace_selection")).toBe("");
  });
});

describe("改写侧：applyEdit 的落点与守卫", () => {
  const build = () =>
    makeEditor(
      pageDoc(
        "页名",
        ...section("小节甲", para("甲的第一段"), para("甲的第二段")),
        ...section("小节乙", para("乙的内容")),
      ),
    );

  it("replace_under_heading 只换掉该小节正文，下一小节不受影响", () => {
    const h = build();
    const bridge = createAiEditorBridge({ editor: h.editor, viewName: "页名" });
    const result = bridge.applyEdit("replace_under_heading", "重写后的段落", { heading: "小节甲" });
    expect(result.applied).toBe(true);
    expect(result.revert).toBeTruthy();
    expect(topBlocks(h).map((b) => b.text)).toEqual(["页名", "", "小节甲", "重写后的段落", "小节乙", "乙的内容"]);
  });

  it("insert_under_heading 落在小节末尾之后", () => {
    const h = build();
    const bridge = createAiEditorBridge({ editor: h.editor, viewName: "页名" });
    expect(bridge.applyEdit("insert_under_heading", "补一段", { heading: "小节甲" }).applied).toBe(true);
    expect(topBlocks(h).map((b) => b.text)).toEqual([
      "页名",
      "",
      "小节甲",
      "甲的第一段",
      "甲的第二段",
      "补一段",
      "小节乙",
      "乙的内容",
    ]);
  });

  it("append_to_document 加在文档最后", () => {
    const h = build();
    const bridge = createAiEditorBridge({ editor: h.editor, viewName: "页名" });
    expect(bridge.applyEdit("append_to_document", "追加行").applied).toBe(true);
    expect(last(topBlocks(h))?.text).toBe("追加行");
  });

  it("replace_text 精确替换命中的那几个字", () => {
    const h = build();
    const bridge = createAiEditorBridge({ editor: h.editor, viewName: "页名" });
    expect(bridge.applyEdit("replace_text", "改过的", { text: "乙的内容" }).applied).toBe(true);
    expect(last(topBlocks(h))?.text).toBe("改过的");
  });

  it("replace_selection 有选区时换掉选中的内容", () => {
    const h = build();
    const bridge = createAiEditorBridge({ editor: h.editor, viewName: "页名" });
    // 顶层块：0=H1、1=分割线、2=小节甲标题、3/4=其正文、5=小节乙标题、6=其正文
    const target = topBlocks(h)[6];
    h.select(target.from + 1, target.to - 1);
    expect(bridge.applyEdit("replace_selection", "选中部分").applied).toBe(true);
    expect(topBlocks(h).map((b) => b.text)).toEqual([
      "页名",
      "",
      "小节甲",
      "甲的第一段",
      "甲的第二段",
      "小节乙",
      "选中部分",
    ]);
  });

  it("replace_selection 没选区时退化成在光标处插入", () => {
    const h = build();
    const bridge = createAiEditorBridge({ editor: h.editor, viewName: "页名" });
    const target = topBlocks(h)[6];
    h.select(target.from + 1, target.from + 1);
    expect(bridge.applyEdit("replace_selection", "光标处").applied).toBe(true);
    expect(
      topBlocks(h)
        .map((b) => b.text)
        .slice(5),
    ).toEqual(["小节乙", "光标处", "乙的内容"]);
  });

  it("锚点找不到时按原因回报，文档一字未动", () => {
    const h = build();
    const bridge = createAiEditorBridge({ editor: h.editor, viewName: "页名" });
    const before = h.docJson();
    expect(bridge.applyEdit("replace_under_heading", "x", { heading: "查无此节" })).toEqual({
      applied: false,
      reason: "ai.locateHeadingNotFound",
    });
    expect(bridge.applyEdit("replace_text", "x", { text: "查无此字" })).toEqual({
      applied: false,
      reason: "ai.locateTextNotFound",
    });
    expect(bridge.applyEdit("replace_text", "x")).toEqual({ applied: false, reason: "ai.locateTextNotFound" });
    expect(h.docJson()).toEqual(before);
  });

  it("首行标题是保护区：改写与插入都拒绝", () => {
    const h = build();
    const bridge = createAiEditorBridge({ editor: h.editor, viewName: "页名" });
    expect(bridge.applyEdit("replace_under_heading", "x", { heading: "页名" })).toEqual({
      applied: false,
      reason: "ai.locateProtectedHeading",
    });
    expect(bridge.applyEdit("insert_under_heading", "x", { heading: "页名" })).toEqual({
      applied: false,
      reason: "ai.locateProtectedHeading",
    });
    expect(bridge.applyEdit("replace_text", "x", { text: "页名" })).toEqual({
      applied: false,
      reason: "ai.locateProtectedHeading",
    });
  });

  it("锚点为空串时按找不到回报，不去动第一个块", () => {
    const h = build();
    const bridge = createAiEditorBridge({ editor: h.editor, viewName: "页名" });
    const before = h.docJson();
    expect(bridge.applyEdit("replace_under_heading", "x", { heading: "" })).toEqual({
      applied: false,
      reason: "ai.locateHeadingNotFound",
    });
    expect(h.docJson()).toEqual(before);
  });
});

describe("撤销侧：undoAiEdit 绝不静默丢弃用户内容", () => {
  // prosemirror-history 按 tr.time（取自 Date.now()）把相邻输入并成一个可撤事件，
  // 夹具里两条事务连着发会被当成同一步、撤掉的就是「AI 改动 + 用户编辑」整体，
  // 于是「用户又编辑过」这条分支永远走不到；这里用假时钟跨过 500ms 的新事件阈值分组。
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const build = () => makeEditor(pageDoc("页名", ...section("小节甲", para("甲的内容"))));

  it("撤一步正好回到改前快照 → true，文档回到 AI 改写之前", () => {
    const h = build();
    const bridge = createAiEditorBridge({ editor: h.editor, viewName: "页名" });
    const before = h.docJson();
    const result = bridge.applyEdit("replace_under_heading", "重写后", { heading: "小节甲" });
    expect(result.applied).toBe(true);
    expect(bridge.undoAiEdit(result.revert)).toBe(true);
    expect(h.docJson()).toEqual(before);
  });

  it("AI 改完用户又编辑过：撤掉的是用户的编辑 → redo 复原并回报 false", () => {
    const h = build();
    const bridge = createAiEditorBridge({ editor: h.editor, viewName: "页名" });
    const result = bridge.applyEdit("append_to_document", "AI 追加", {});
    const revert = result.revert;
    vi.advanceTimersByTime(600);
    const end = h.state().doc.content.size - 1;
    h.select(end, end);
    h.type("（用户补的）");
    const afterUserEdit = h.docJson();
    expect(bridge.undoAiEdit(revert)).toBe(false);
    // 文档必须仍是「AI 改动 + 用户编辑」都在，撤销栈也没被吃掉一步
    expect(h.docJson()).toEqual(afterUserEdit);
    expect(last(topBlocks(h))?.text).toBe("AI 追加（用户补的）");
  });

  it("redo 没能复原时整体写回兜底，且必须带 STRUCTURE_SYNC_META", () => {
    const h = makeEditor(pageDoc("页名", ...section("小节甲", para("甲的内容"))), { redoFails: true });
    const bridge = createAiEditorBridge({ editor: h.editor, viewName: "页名" });
    const result = bridge.applyEdit("replace_under_heading", "重写后", { heading: "小节甲" });
    vi.advanceTimersByTime(600);
    // 撤销栈里再多一步用户编辑，让 undo 落不到 AI 改前快照上
    const end = h.state().doc.content.size - 1;
    h.select(end, end);
    h.type("用户又打了一次");
    const current = h.docJson();
    h.dispatched().length = 0;
    expect(bridge.undoAiEdit(result.revert)).toBe(false);
    const fallback = last(h.dispatched());
    expect(fallback).toBeTruthy();
    expect(fallback?.getMeta(STRUCTURE_SYNC_META)).toBe(true);
    // 兜底写回的是「undoAiEdit 被调用那一刻」的文档：用户后打的字一个字都不能少
    expect(h.docJson()).toEqual(current);
    expect(last(topBlocks(h))?.text).toBe("重写后用户又打了一次");
  });

  it("快照 JSON 非法 / 没有快照 → false 且不碰文档", () => {
    const h = build();
    const bridge = createAiEditorBridge({ editor: h.editor, viewName: "页名" });
    const before = h.docJson();
    expect(bridge.undoAiEdit(undefined)).toBe(false);
    expect(bridge.undoAiEdit({ before: { type: "no_such_node" } })).toBe(false);
    expect(h.docJson()).toEqual(before);
  });
});

describe("登记之外的边界", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("同一编辑器重复建桥互不影响（分栏时每个实例各建一条）", () => {
    const h = makeEditor(pageDoc("页名", para("正文")));
    const a = createAiEditorBridge({ editor: h.editor, viewName: "页名" });
    const b = createAiEditorBridge({ editor: h.editor, viewName: "另一个名字" });
    expect(a.getPageTitle()).toBe("页名");
    expect(b.getPageTitle()).toBe("另一个名字");
    expect(a.applyEdit("append_to_document", "只落一次").applied).toBe(true);
    expect(topBlocks(h).filter((x) => x.text === "只落一次")).toHaveLength(1);
  });
});
