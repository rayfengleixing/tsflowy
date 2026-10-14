import { describe, expect, it } from "vitest";
import { embeddableDatabaseViews, resolveDatabaseViewName, EMBED_MAX_ROWS } from "./database-view";
import type { LayoutType, View, ViewNode } from "@/types/models";

const v = (id: string, layout: LayoutType, name = id, children: ViewNode[] = []): ViewNode => {
  const base: View = {
    id,
    workspace_id: "w1",
    parent_id: null,
    name,
    icon: null,
    layout,
    extra: "{}",
    position: 0,
    is_favorite: 0,
    is_trash: 0,
    deleted_at: null,
    created_at: 0,
    updated_at: 0,
    visited_at: null,
    source_id: null,
    tags: "[]",
  };
  return { ...base, children };
};

describe("embeddableDatabaseViews", () => {
  const tree = [
    v("root", "document", "首页", [
      v("g1", "grid", "任务表"),
      v("b1", "board", "看板"),
      v("c1", "calendar", "日历表"),
      v("t1", "timeline", "时间线", [v("g2", "grid", "深层表格")]),
      v("d2", "document", "普通文档"),
    ]),
  ];

  it("列出全部数据库布局（含深层嵌套），不再只有 grid", () => {
    expect(embeddableDatabaseViews(tree).map((x) => x.id)).toEqual(["g1", "b1", "c1", "t1", "g2"]);
  });

  it("排除文档布局（行详情页是带 row_detail 的 document，随之排除）", () => {
    expect(embeddableDatabaseViews(tree).every((x) => x.layout !== "document")).toBe(true);
  });

  it("空树返回空数组", () => {
    expect(embeddableDatabaseViews([])).toEqual([]);
  });
});

describe("resolveDatabaseViewName", () => {
  const tree = [v("host", "document", "宿主", [v("g1", "grid", "改名后的表"), v("g2", "grid", "   ")])];

  it("树里的当前名称优先（重命名后不再显示插入时快照）", () => {
    expect(resolveDatabaseViewName(tree, "g1", "旧名字", "数据库")).toBe("改名后的表");
  });

  it("树中查不到（页面已删除）回落快照名", () => {
    expect(resolveDatabaseViewName(tree, "gone", "快照名", "数据库")).toBe("快照名");
  });

  it("快照名也为空时用默认名", () => {
    expect(resolveDatabaseViewName(tree, "gone", "", "数据库")).toBe("数据库");
  });

  it("目标在树里但无名称时逐级回落", () => {
    expect(resolveDatabaseViewName(tree, "g2", "快照", "数据库")).toBe("快照");
    expect(resolveDatabaseViewName(tree, "g2", "", "数据库")).toBe("数据库");
  });

  it("viewId 为空回落快照/默认", () => {
    expect(resolveDatabaseViewName(tree, null, "快照", "数据库")).toBe("快照");
  });
});

describe("EMBED_MAX_ROWS", () => {
  it("嵌入行数上限为合理值（大于旧实现的 8）", () => {
    expect(EMBED_MAX_ROWS).toBeGreaterThan(8);
  });
});
