// 与 migrations/001_init.sql 表结构一一对应（项目说明书第 7 章）

export type LayoutType = "document" | "grid" | "board" | "calendar";

export interface Workspace {
  id: string;
  name: string;
  icon: string | null; // emoji 字符，NULL=默认
  created_at: number;
  updated_at: number;
}

export interface View {
  id: string;
  workspace_id: string;
  parent_id: string | null;
  name: string;
  icon: string | null;
  layout: LayoutType;
  extra: string; // JSON
  position: number;
  is_favorite: number; // 0/1
  is_trash: number; // 0/1
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
  /** 最近一次被用户打开（openView）的时间戳；NULL=从未访问（Phase 3.2 Recent Tab） */
  visited_at: number | null;
  /** 多视图（迁移 007）：非空 = 数据库页内的派生视图，值为其宿主视图 id；派生视图不在树/回收站/搜索中出现 */
  source_id: string | null;
  /** 页面标签（迁移 009）：JSON 数组字符串，如 `["工作","重要"]`；用 parseViewTags() 解析 */
  tags: string;
}

export interface ViewNode extends View {
  children: ViewNode[];
}

/** 安全解析 views.tags JSON 列（坏数据静默为空数组） */
export function parseViewTags(tags: string | null | undefined): string[] {
  if (!tags) return [];
  try {
    const v = JSON.parse(tags);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export const LAYOUTS: LayoutType[] = ["document", "grid", "board", "calendar"];

/** 数据库视图布局集合：一张表可拥有的视图类型（多视图阶段 2） */
export const DB_LAYOUTS = ["grid", "board", "calendar"] as const;
export type DbLayout = (typeof DB_LAYOUTS)[number];
