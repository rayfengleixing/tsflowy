import { describe, expect, it } from "vitest";
import { Node as PMNode, Schema } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import {
  TaskItemWithMeta,
  buildTaskItemAttributes,
  buildTaskMetaTr,
  taskItemPositions,
  taskMetaOfNode,
} from "./task-meta";

/** 只用节点名与 attrs 形状对上真实扩展，坐标数学与事务构造跟真实 schema 一致 */
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    taskList: { group: "block", content: "taskItem+" },
    taskItem: {
      group: "block",
      content: "paragraph block*",
      attrs: {
        checked: { default: false },
        due: { default: null },
        assignee: { default: null },
        chip: { default: null },
      },
    },
    text: { group: "inline" },
  },
});

function taskListJson(items: Record<string, unknown>[], text = "任务") {
  return {
    type: "taskList",
    content: items.map((attrs) => ({
      type: "taskItem",
      attrs,
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    })),
  };
}

function docWith(content: unknown[]): PMNode {
  return schema.nodeFromJSON({ type: "doc", content });
}

describe("taskItemPositions", () => {
  it("列出容器内每一行的绝对位置（容器起点 + 1 + 内容内偏移）", () => {
    // 前导段落「引」占 3（开 + 文本 + 闭），容器落在 pos 3；每行 = 开 1 + 段落 4 + 闭 1 = 6
    const doc = docWith([
      { type: "paragraph", content: [{ type: "text", text: "引" }] },
      taskListJson([{ checked: false }, { checked: true }]),
    ]);
    const items = taskItemPositions(doc, 3);
    expect(items.map((i) => i.pos)).toEqual([4, 10]);
    expect(items.map((i) => (i.node.attrs as { checked?: unknown }).checked)).toEqual([false, true]);
    expect(doc.nodeAt(4)?.type.name).toBe("taskItem");
    expect(doc.nodeAt(10)?.type.name).toBe("taskItem");
  });

  it("容器就是文档第一个块时从 1 开始", () => {
    const doc = docWith([taskListJson([{ checked: false }])]);
    expect(taskItemPositions(doc, 0).map((i) => i.pos)).toEqual([1]);
  });

  it("pos 不是 taskList、或越界时返回空数组", () => {
    const doc = docWith([
      { type: "paragraph", content: [{ type: "text", text: "普通段落" }] },
      taskListJson([{ checked: false }]),
    ]);
    expect(taskItemPositions(doc, 0)).toEqual([]); // 段落不是容器
    expect(taskItemPositions(doc, -1)).toEqual([]);
    expect(taskItemPositions(doc, doc.content.size)).toEqual([]);
    expect(taskItemPositions(doc, 9999)).toEqual([]);
  });
});

describe("buildTaskMetaTr", () => {
  const state = () => EditorState.create({ doc: docWith([taskListJson([{ checked: true }])]) });

  it("写入日期与负责人，保留 checked 与行内文本", () => {
    const tr = buildTaskMetaTr(state(), 1, { due: "2026-10-20", assignee: "张三" });
    expect(tr).not.toBeNull();
    const item = (tr ?? state().tr).doc.nodeAt(1);
    expect(item?.attrs.due).toBe("2026-10-20");
    expect(item?.attrs.assignee).toBe("张三");
    expect(item?.attrs.checked).toBe(true);
    expect(item?.textContent).toBe("任务");
  });

  it("传 null 是清除，没传的字段不动", () => {
    const first = buildTaskMetaTr(state(), 1, { due: "2026-10-20", assignee: "张三" });
    const doc = first?.doc ?? docWith([]);
    const next = EditorState.create({ doc });
    const tr = buildTaskMetaTr(next, 1, { due: null });
    const item = tr?.doc.nodeAt(1);
    expect(item?.attrs.due).toBeNull();
    expect(item?.attrs.assignee).toBe("张三");
  });

  it("坏日期与纯空白负责人归成 null，与现状相同就不产生事务", () => {
    expect(buildTaskMetaTr(state(), 1, { due: "2026-02-30" })).toBeNull();
    expect(buildTaskMetaTr(state(), 1, { assignee: "   " })).toBeNull();
    expect(buildTaskMetaTr(state(), 1, {})).toBeNull();
  });

  it("负责人里的尖括号会被去掉，避免撑破 Markdown 行尾标记", () => {
    const tr = buildTaskMetaTr(state(), 1, { assignee: "<b>张三</b>" });
    const assignee = String(tr?.doc.nodeAt(1)?.attrs.assignee);
    expect(assignee).not.toContain("<");
    expect(assignee).not.toContain(">");
  });

  it("pos 指向的不是 taskItem 时返回 null", () => {
    const doc = docWith([
      { type: "paragraph", content: [{ type: "text", text: "段落" }] },
      taskListJson([{ checked: false }]),
    ]);
    expect(buildTaskMetaTr(EditorState.create({ doc }), 0, { due: "2026-10-20" })).toBeNull();
    expect(buildTaskMetaTr(EditorState.create({ doc }), 12345, { due: "2026-10-20" })).toBeNull();
  });
});

describe("taskMetaOfNode", () => {
  it("把 attrs 里的坏数据归零", () => {
    const node = schema.nodeFromJSON(taskListJson([{ due: "2026-13-40", assignee: " 李四 " }]).content[0]);
    expect(taskMetaOfNode(node)).toEqual({ due: null, assignee: "李四" });
  });
});

describe("buildTaskItemAttributes", () => {
  const attrs = buildTaskItemAttributes({ checked: { default: false } });

  it("保留 TaskItem 自带的 checked", () => {
    expect(attrs.checked).toEqual({ default: false });
  });

  it("due / assignee 各自只写自己的 data 属性，空值不写", () => {
    const due = attrs.due.renderHTML({ due: "2026-10-20" });
    expect(due).toEqual({ "data-due": "2026-10-20" });
    expect(attrs.due.renderHTML({ due: null })).toEqual({});
    expect(attrs.due.renderHTML({ due: "乱写" })).toEqual({});
    expect(attrs.assignee.renderHTML({ assignee: "张三" })).toEqual({ "data-assignee": "张三" });
    expect(attrs.assignee.renderHTML({ assignee: "" })).toEqual({});
  });

  it("chip 拼出整段文案并带上状态；两者都空时什么都不写", () => {
    const past = attrs.chip.renderHTML({ due: "1999-01-01", assignee: "张三" }) as Record<string, string>;
    expect(past["data-task-meta"]).toBe("📅 1999-01-01 · 👤 张三");
    expect(past["data-task-state"]).toBe("overdue");
    const future = attrs.chip.renderHTML({ due: "2999-12-31", assignee: null }) as Record<string, string>;
    expect(future["data-task-state"]).toBe("upcoming");
    expect(attrs.chip.renderHTML({ due: null, assignee: null })).toEqual({});
    // 只有负责人时没有状态（状态只跟日期有关）
    expect(Object.keys(attrs.chip.renderHTML({ due: null, assignee: "张三" }))).toEqual(["data-task-meta"]);
  });

  it("paste 回来的 HTML 用 data 属性还原日期与负责人，坏值退回 null", () => {
    const element = (values: Record<string, string | null>) =>
      ({ getAttribute: (name: string) => values[name] ?? null }) as unknown as HTMLElement;
    expect(attrs.due.parseHTML(element({ "data-due": "2026-10-20" }))).toBe("2026-10-20");
    expect(attrs.due.parseHTML(element({ "data-due": "not-a-date" }))).toBeNull();
    expect(attrs.assignee.parseHTML(element({ "data-assignee": "张三" }))).toBe("张三");
    expect(attrs.assignee.parseHTML(element({}))).toBeNull();
  });
});

describe("TaskItemWithMeta", () => {
  it("扩展名仍是 taskItem，替换后 Markdown / CSS 选择器都不用改", () => {
    expect(TaskItemWithMeta.name).toBe("taskItem");
  });
});
