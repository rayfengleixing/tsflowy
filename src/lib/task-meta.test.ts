import { describe, expect, it } from "vitest";
import {
  MAX_ASSIGNEE_LENGTH,
  dueState,
  encodeTaskMeta,
  normalizeAssignee,
  normalizeDue,
  stripTaskMeta,
  taskMetaLabel,
  taskMetaOf,
  todayIso,
} from "./task-meta";

describe("normalizeDue", () => {
  it("接受合法的 YYYY-MM-DD 并去掉首尾空白", () => {
    expect(normalizeDue("2026-10-20")).toBe("2026-10-20");
    expect(normalizeDue("  2026-10-20  ")).toBe("2026-10-20");
  });

  it("拒绝形状不对的串", () => {
    for (const bad of ["", "2026-10-1", "2026/10/20", "20261-10-20", "2026-13-01", "2026-00-10", "明天"]) {
      expect(normalizeDue(bad)).toBeNull();
    }
  });

  it("拒绝不存在的日历日而不是让 Date 静默进位", () => {
    expect(normalizeDue("2026-02-30")).toBeNull();
    expect(normalizeDue("2026-04-31")).toBeNull();
    expect(normalizeDue("2023-02-29")).toBeNull();
    expect(normalizeDue("2024-02-29")).toBe("2024-02-29");
    expect(normalizeDue("2026-12-31")).toBe("2026-12-31");
  });

  it("非字符串一律 null", () => {
    for (const bad of [null, undefined, 42, {}, [], true]) expect(normalizeDue(bad)).toBeNull();
  });
});

describe("normalizeAssignee", () => {
  it("去首尾空白，空串算没有负责人", () => {
    expect(normalizeAssignee("  张三  ")).toBe("张三");
    expect(normalizeAssignee("   ")).toBeNull();
    expect(normalizeAssignee(null)).toBeNull();
  });

  it("挡掉尖括号，免得写进行尾注释后把标记结构破坏", () => {
    const clean = normalizeAssignee("<script>alert(1)</script>");
    expect(clean).not.toContain("<");
    expect(clean).not.toContain(">");
  });

  it("超长截断", () => {
    const long = "甲".repeat(MAX_ASSIGNEE_LENGTH + 20);
    expect(normalizeAssignee(long)).toHaveLength(MAX_ASSIGNEE_LENGTH);
  });
});

describe("taskMetaOf", () => {
  it("把任意 attrs 收进 TaskMeta", () => {
    expect(taskMetaOf(undefined)).toEqual({ due: null, assignee: null });
    expect(taskMetaOf({})).toEqual({ due: null, assignee: null });
    expect(taskMetaOf({ due: "2026-02-30", assignee: " 李四 " })).toEqual({ due: null, assignee: "李四" });
  });
});

describe("todayIso / dueState", () => {
  it("按本地日历日取今天，月日补零", () => {
    expect(todayIso(new Date(2026, 9, 5))).toBe("2026-10-05");
    expect(todayIso(new Date(2026, 0, 31))).toBe("2026-01-31");
  });

  it("过去 / 今天 / 将来三档，无日期返回 null", () => {
    const today = "2026-10-15";
    expect(dueState("2026-10-14", today)).toBe("overdue");
    expect(dueState("2026-10-15", today)).toBe("today");
    expect(dueState("2026-10-16", today)).toBe("upcoming");
    expect(dueState(null, today)).toBeNull();
  });

  it("跨月跨年比较不受字典序影响", () => {
    expect(dueState("2025-12-31", "2026-01-01")).toBe("overdue");
    expect(dueState("2026-01-01", "2025-12-31")).toBe("upcoming");
  });
});

describe("taskMetaLabel", () => {
  it("两项都有用 · 连接，只有一项时不带分隔符", () => {
    expect(taskMetaLabel({ due: "2026-10-20", assignee: "张三" })).toBe("📅 2026-10-20 · 👤 张三");
    expect(taskMetaLabel({ due: "2026-10-20", assignee: null })).toBe("📅 2026-10-20");
    expect(taskMetaLabel({ due: null, assignee: "张三" })).toBe("👤 张三");
    expect(taskMetaLabel({ due: null, assignee: null })).toBe("");
  });
});

describe("encodeTaskMeta / stripTaskMeta", () => {
  it("没有元数据时不写标记，历史导出格式不变", () => {
    expect(encodeTaskMeta({ due: null, assignee: null })).toBe("");
  });

  it("due 在前、assignee 在后", () => {
    expect(encodeTaskMeta({ due: "2026-10-20", assignee: null })).toBe(" <!-- task due=2026-10-20 -->");
    expect(encodeTaskMeta({ due: null, assignee: "张三" })).toBe(" <!-- task assignee=张三 -->");
    expect(encodeTaskMeta({ due: "2026-10-20", assignee: "张三" })).toBe(" <!-- task due=2026-10-20 assignee=张三 -->");
  });

  it("写出去再摘回来，正文与元数据都原样", () => {
    const meta = { due: "2026-10-20", assignee: "张三 三" };
    const line = `写周报${encodeTaskMeta(meta)}`;
    expect(stripTaskMeta(line)).toEqual({ body: "写周报", meta });
  });

  it("没有标记的正文一个字都不动", () => {
    expect(stripTaskMeta("写周报")).toEqual({ body: "写周报", meta: { due: null, assignee: null } });
  });

  it("只认行尾标记，出现在中间就当正文", () => {
    const text = "任务 <!-- task due=2026-10-20 --> 尾巴";
    expect(stripTaskMeta(text).body).toBe(text);
    expect(stripTaskMeta(text).meta).toEqual({ due: null, assignee: null });
  });

  it("标记里是坏日期就当没写，但标记本身要被摘掉", () => {
    expect(stripTaskMeta("任务 <!-- task due=2026-02-30 -->")).toEqual({
      body: "任务",
      meta: { due: null, assignee: null },
    });
  });

  it("空标记 `<!-- task -->` 也摘干净", () => {
    expect(stripTaskMeta("任务 <!-- task -->").body).toBe("任务");
  });

  it("负责人里带尖括号时整个标记不被识别，正文保持原样", () => {
    const text = "任务 <!-- task assignee=a<b -->";
    expect(stripTaskMeta(text).body).toBe(text);
  });
});
