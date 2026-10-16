import { describe, expect, it } from "vitest";
import { Schema, Node as PMNode } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";

import {
  MIN_FRACTION,
  buildRatiosTr,
  columnIndexOf,
  columnsAncestorPos,
  evenRatios,
  normalizeRatio,
  normalizeRatios,
  readRatios,
  shiftRatios,
} from "./ratio";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    banner: { group: "block", content: "block+" },
    columns: { group: "block", content: "column+" },
    column: { group: "block", content: "block+", attrs: { ratio: { default: 1 } } },
    text: { group: "inline" },
  },
  marks: {},
});

function columnsDoc(ratios: number[], outer = false): PMNode {
  const columns = {
    type: "columns",
    content: ratios.map((ratio, i) => ({
      type: "column",
      attrs: { ratio },
      content: [{ type: "paragraph", content: [{ type: "text", text: `c${i}` }] }],
    })),
  };
  return schema.nodeFromJSON(
    outer
      ? { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "lead" }] }, columns] }
      : { type: "doc", content: [columns] },
  );
}

function state(doc: PMNode) {
  return EditorState.create({ doc, schema });
}

/** 断言「这一步该有结果」，省掉测试里的非空断言 */
function need<T>(value: T | null): T {
  if (value === null) throw new Error("expected a result, got null");
  return value;
}

interface ColumnJson {
  attrs?: { ratio?: number };
  content?: { content?: { text?: string }[] }[];
}

/** 从结果 doc 里取第 columnsIndex 个顶层块（分栏容器）的各列 JSON */
function columnsOf(doc: PMNode, columnsIndex: number): ColumnJson[] {
  const json = doc.toJSON() as { content?: { content?: ColumnJson[] }[] };
  const block = json.content?.[columnsIndex];
  if (!block?.content) throw new Error("columns block missing");
  return block.content;
}

function textOf(column: ColumnJson): string | undefined {
  return column.content?.[0]?.content?.[0]?.text;
}

describe("normalizeRatio", () => {
  it("接受数字与数字字符串", () => {
    expect(normalizeRatio(2)).toBe(2);
    expect(normalizeRatio("1.5")).toBe(1.5);
  });

  it("坏数据退回均分用的 1", () => {
    for (const bad of [0, -3, Number.NaN, Number.POSITIVE_INFINITY, undefined, null, "abc", {}]) {
      expect(normalizeRatio(bad)).toBe(1);
    }
  });

  it("极端值夹进允许区间", () => {
    expect(normalizeRatio(1000)).toBe(20);
    expect(normalizeRatio(0.0001)).toBe(0.05);
  });

  it("保留三位小数，写进导出标记不会拖尾", () => {
    expect(normalizeRatio(1 / 3)).toBe(0.333);
  });
});

describe("evenRatios / normalizeRatios", () => {
  it("均分是每列 1，长度等于列数", () => {
    expect(evenRatios(3)).toEqual([1, 1, 1]);
    expect(evenRatios(0)).toEqual([]);
  });

  it("值不足列数时补 1，多余值丢弃，坏值单独替换", () => {
    expect(normalizeRatios([2], 3)).toEqual([2, 1, 1]);
    expect(normalizeRatios([2, 3, 4, 5], 3)).toEqual([2, 3, 4]);
    expect(normalizeRatios([2, "x", 4], 3)).toEqual([2, 1, 4]);
  });
});

describe("shiftRatios", () => {
  it("两列：delta 是按整行宽算的比例，正方向把右列让给左列", () => {
    expect(shiftRatios([1, 1], 1, 0.25)).toEqual([1.5, 0.5]);
  });

  it("拖到底也留得下 MIN_FRACTION 的宽度", () => {
    const next = need(shiftRatios([1, 1], 1, 0.9));
    expect(next[1] / (next[0] + next[1])).toBeCloseTo(MIN_FRACTION, 3);
    // 反向同样有下限
    const back = need(shiftRatios([1, 1], 1, -0.9));
    expect(back[0] / (back[0] + back[1])).toBeCloseTo(MIN_FRACTION, 3);
  });

  it("三列只动分隔条两侧，第三列占比不变", () => {
    expect(shiftRatios([1, 1, 1], 1, 0.1)).toEqual([1.3, 0.7, 1]);
  });

  it("总和保持不变（只重新分配，不整体缩放）", () => {
    const base = [1, 2, 1];
    const next = need(shiftRatios(base, 2, 0.12));
    expect(next.reduce((sum, r) => sum + r, 0)).toBeCloseTo(
      base.reduce((sum, r) => sum + r, 0),
      2,
    );
  });

  it("没有可动的量或非法输入返回 null", () => {
    expect(shiftRatios([1], 1, 0.1)).toBeNull(); // 单列没有分隔条
    expect(shiftRatios([1, 1], 0, 0.1)).toBeNull();
    expect(shiftRatios([1, 1], 2, 0.1)).toBeNull();
    expect(shiftRatios([1, 1], 1, Number.NaN)).toBeNull();
    expect(shiftRatios([1, 1], 1, 0)).toBeNull(); // 原地不动就别派发事务
  });

  it("已经贴到下限的一侧继续同向拖返回 null", () => {
    const pinned = need(shiftRatios([1, 1], 1, -0.9)); // 左列已贴到下限
    expect(pinned[0] / (pinned[0] + pinned[1])).toBeCloseTo(MIN_FRACTION, 3);
    expect(shiftRatios(pinned, 1, -0.9)).toBeNull();
  });
});

describe("columnsAncestorPos / columnIndexOf", () => {
  // 「c0」段落 nodeSize = 2+2 = 4，column 包一层 = 6；容器进入 1，故列起点 = columnsPos + 1 + 6*i
  it("顶层分栏在 pos 0，第二列序号为 1", () => {
    const doc = columnsDoc([1, 1]);
    const columnsPos = need(columnsAncestorPos(doc, 2));
    expect(columnsPos).toBe(0);
    expect(columnIndexOf(doc, columnsPos, 1)).toBe(0);
    expect(columnIndexOf(doc, columnsPos, 7)).toBe(1);
    expect(columnIndexOf(doc, columnsPos, 6)).toBeNull();
  });

  it("嵌在其它块里的分栏也能定位", () => {
    const doc = columnsDoc([1, 1, 1], true);
    const columnsPos = need(columnsAncestorPos(doc, 8));
    expect(columnsPos).toBe(6); // 前导段落「lead」nodeSize = 6
    expect(columnIndexOf(doc, columnsPos, 13)).toBe(1);
    expect(columnIndexOf(doc, columnsPos, 19)).toBe(2);
  });

  it("不在分栏内或越界返回 null", () => {
    const doc = schema.nodeFromJSON({ type: "doc", content: [{ type: "paragraph", text: "x" }] });
    expect(columnsAncestorPos(doc, 1)).toBeNull();
    expect(columnsAncestorPos(doc, -1)).toBeNull();
    expect(columnsAncestorPos(doc, doc.content.size + 10)).toBeNull();
    expect(columnIndexOf(doc, 0, 0)).toBeNull();
  });
});

describe("readRatios", () => {
  it("读出每列的比例，坏数据先归一", () => {
    const doc = columnsDoc([1, 2.5]);
    expect(readRatios(doc, 0)).toEqual([1, 2.5]);
    const broken = schema.nodeFromJSON({
      type: "doc",
      content: [{ type: "columns", content: [{ type: "column", attrs: { ratio: "x" } }] }],
    });
    expect(readRatios(broken, 0)).toEqual([1]);
  });

  it("pos 不是 columns 返回 null", () => {
    const doc = columnsDoc([1, 1], true);
    expect(readRatios(doc, 0)).toBeNull();
    expect(readRatios(doc, 999)).toBeNull();
  });
});

describe("buildRatiosTr", () => {
  it("改写各列 attrs 且不动列内内容", () => {
    const st = state(columnsDoc([1, 1, 1], true));
    const tr = buildRatiosTr(st, 6, [2, 1, 0.5]);
    const columns = columnsOf(need(tr).doc, 1);
    expect(columns.map((c) => c.attrs?.ratio)).toEqual([2, 1, 0.5]);
    expect(columns.map((c) => textOf(c))).toEqual(["c0", "c1", "c2"]);
  });

  it("目标不是 columns / 长度不符 / 空容器都拒绝", () => {
    expect(buildRatiosTr(state(columnsDoc([1, 1], true)), 0, [1, 1])).toBeNull();
    expect(buildRatiosTr(state(columnsDoc([1, 1])), 0, [1, 1, 1])).toBeNull();
    expect(buildRatiosTr(state(columnsDoc([1, 1])), 999, [1, 1])).toBeNull();
  });

  it("坏比例在入口就被换成合法值", () => {
    const tr = buildRatiosTr(state(columnsDoc([1, 1])), 0, [1e6, -2]);
    expect(columnsOf(need(tr).doc, 0).map((c) => c.attrs?.ratio)).toEqual([20, 1]);
  });
});
