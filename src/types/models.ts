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
}

export interface ViewNode extends View {
  children: ViewNode[];
}

export const LAYOUTS: LayoutType[] = ["document", "grid", "board", "calendar"];
