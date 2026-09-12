import { invoke } from "@tauri-apps/api/core";
import type { LayoutType, View, Workspace } from "@/types/models";

// Phase A–C 完成：全部持久化已下沉 Rust 领域命令（invoke），tauri-plugin-sql 已移除。
// 写串行化与事务由 Rust 侧单写连接保证；PRAGMA 由 Rust 侧 apply_pragmas 统一施加。
// newId 保留：主键仍由前端生成。

export function newId(): string {
  return crypto.randomUUID();
}

// ---------- 空间 / 视图 / 设置（Phase A：持久化下沉 Rust 领域命令） ----------
// 行结构由 Rust 侧 serde 结构体产出，字段名 == SQL 列名（snake_case），与旧 select 行形状一致。
// 参数契约：顶层参数 camelCase（Tauri 2 自动映射到 Rust snake_case）。

export const workspaceApi = {
  async list(): Promise<Workspace[]> {
    return invoke<Workspace[]>("workspace_list");
  },

  async create(name: string): Promise<Workspace> {
    // id 仍由前端生成（crypto.randomUUID），作为参数传入
    return invoke<Workspace>("workspace_create", { id: newId(), name });
  },

  async rename(id: string, name: string): Promise<void> {
    return invoke("workspace_rename", { id, name });
  },

  async setIcon(id: string, icon: string | null): Promise<void> {
    return invoke("workspace_set_icon", { id, icon });
  },

  /** 级联删除空间及其下全部视图/文档（FK ON DELETE CASCADE） */
  async remove(id: string): Promise<void> {
    return invoke("workspace_remove", { id });
  },
};

export const viewApi = {
  /** 排除行详情视图（说明书 12 节风险 7：extra 标记 {"row_detail":true}） */
  async listByWorkspace(workspaceId: string): Promise<View[]> {
    return invoke<View[]>("view_list_by_workspace", { workspaceId });
  },

  async listTrash(workspaceId: string): Promise<View[]> {
    return invoke<View[]>("view_list_trash", { workspaceId });
  },

  /** 最近访问视图：按 visited_at 倒序（Phase 3.2 - Recent Tab） */
  async listRecent(workspaceId: string, limit = 30): Promise<View[]> {
    return invoke<View[]>("view_list_recent", { workspaceId, limit });
  },

  /** 标记视图为"最近被打开"：openView 时调用，驱动 Recent Tab 列表 */
  async touchVisited(id: string): Promise<void> {
    return invoke("view_touch_visited", { id });
  },

  async create(opts: {
    workspace_id: string;
    parent_id: string | null;
    name: string;
    layout: LayoutType;
    extra?: string;
  }): Promise<View> {
    return invoke<View>("view_create", {
      id: newId(),
      workspaceId: opts.workspace_id,
      parentId: opts.parent_id,
      name: opts.name,
      layout: opts.layout,
      extra: opts.extra ?? null,
    });
  },

  /** 按 id 读单个视图（行详情文档等）；不存在返回 null */
  async get(id: string): Promise<View | null> {
    return invoke<View | null>("view_get", { id });
  },

  async rename(id: string, name: string): Promise<void> {
    return invoke("view_rename", { id, name });
  },

  async setIcon(id: string, icon: string | null): Promise<void> {
    return invoke("view_set_icon", { id, icon });
  },

  /** 软删：视图及其整个子树进回收站 */
  async softDelete(id: string): Promise<void> {
    return invoke("view_soft_delete", { id });
  },

  /** 恢复：视图及其子树移出回收站 */
  async restore(id: string): Promise<void> {
    return invoke("view_restore", { id });
  },

  /** 彻底删除：子树递归硬删（documents/database_* 经 FK 级联） */
  async purge(id: string): Promise<void> {
    return invoke("view_purge", { id });
  },

  async purgeTrash(workspaceId: string): Promise<void> {
    return invoke("view_purge_trash", { workspaceId });
  },

  /** 永久删除回收站中 deleted_at 早于 deadlineMs（毫秒时间戳）的视图，返回删除行数 */
  async purgeExpiredTrash(workspaceId: string, deadlineMs: number): Promise<number> {
    return invoke<number>("view_purge_expired_trash", { workspaceId, deadlineMs });
  },

  /**
   * 移动视图：Rust 侧单事务完成后代守卫 + computeRenumber 镜像 + 两侧兄弟重排。
   */
  async move(viewId: string, newParentId: string | null, index: number): Promise<void> {
    return invoke("view_move", { viewId, newParentId, index });
  },

  /** 获取当前应用的工作区标识（app_settings 键值，供 store 恢复） */
  async getSetting(key: string): Promise<string | null> {
    return invoke<string | null>("setting_get", { key });
  },

  async setSetting(key: string, value: string): Promise<void> {
    return invoke("setting_set", { key, value });
  },
};
