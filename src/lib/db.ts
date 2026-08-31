import Database from "@tauri-apps/plugin-sql";
import type { LayoutType, View, Workspace } from "@/types/models";
import { computeRenumber } from "@/lib/tree";

// 所有 SQL 集中在本模块（项目说明书 9.3 节），组件不直接拼 SQL。

let db: Database | null = null;

export async function getDb(): Promise<Database> {
  if (!db) {
    db = await Database.load("sqlite:appflowy.db");
  }
  return db;
}

const now = () => Date.now();

export function newId(): string {
  return crypto.randomUUID();
}

// ---------- 空间 ----------
export const workspaceApi = {
  async list(): Promise<Workspace[]> {
    const d = await getDb();
    return d.select<Workspace[]>("SELECT * FROM workspaces ORDER BY created_at ASC");
  },

  async create(name: string): Promise<Workspace> {
    const d = await getDb();
    const id = newId();
    const t = now();
    await d.execute(
      "INSERT INTO workspaces(id, name, created_at, updated_at) VALUES ($1, $2, $3, $4)",
      [id, name, t, t],
    );
    return { id, name, icon: null, created_at: t, updated_at: t };
  },

  async rename(id: string, name: string): Promise<void> {
    const d = await getDb();
    await d.execute("UPDATE workspaces SET name = $1, updated_at = $2 WHERE id = $3", [
      name,
      now(),
      id,
    ]);
  },

  async setIcon(id: string, icon: string | null): Promise<void> {
    const d = await getDb();
    await d.execute("UPDATE workspaces SET icon = $1, updated_at = $2 WHERE id = $3", [
      icon,
      now(),
      id,
    ]);
  },

  /** 级联删除空间及其下全部视图/文档（FK ON DELETE CASCADE） */
  async remove(id: string): Promise<void> {
    const d = await getDb();
    await d.execute("DELETE FROM workspaces WHERE id = $1", [id]);
  },
};

// ---------- 视图 ----------
export const viewApi = {
  async listByWorkspace(workspaceId: string): Promise<View[]> {
    const d = await getDb();
    return d.select<View[]>(
      "SELECT * FROM views WHERE workspace_id = $1 AND is_trash = 0 ORDER BY position ASC",
      [workspaceId],
    );
  },

  async listTrash(workspaceId: string): Promise<View[]> {
    const d = await getDb();
    return d.select<View[]>(
      "SELECT * FROM views WHERE workspace_id = $1 AND is_trash = 1 ORDER BY deleted_at DESC",
      [workspaceId],
    );
  },

  async listFavorites(workspaceId: string): Promise<View[]> {
    const d = await getDb();
    return d.select<View[]>(
      "SELECT * FROM views WHERE workspace_id = $1 AND is_trash = 0 AND is_favorite = 1 ORDER BY position ASC",
      [workspaceId],
    );
  },

  async create(opts: {
    workspace_id: string;
    parent_id: string | null;
    name: string;
    layout: LayoutType;
  }): Promise<View> {
    const d = await getDb();
    const id = newId();
    const t = now();
    const rows = await d.select<{ p: number }[]>(
      "SELECT COALESCE(MAX(position), -1) + 1 AS p FROM views WHERE workspace_id = $1 AND parent_id IS $2",
      [opts.workspace_id, opts.parent_id],
    );
    const position = rows[0]?.p ?? 0;
    await d.execute(
      `INSERT INTO views(id, workspace_id, parent_id, name, layout, position, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
      [id, opts.workspace_id, opts.parent_id, opts.name, opts.layout, position, t],
    );
    if (opts.layout === "document") {
      // 文档布局需预置空内容行（说明书 14 节：新建视图时须插入默认 content 行）
      await d.execute(
        'INSERT INTO documents(view_id, content, updated_at) VALUES ($1, \'{"type":"doc","content":[]}\', $2)',
        [id, t],
      );
    }
    return {
      id,
      workspace_id: opts.workspace_id,
      parent_id: opts.parent_id,
      name: opts.name,
      icon: null,
      layout: opts.layout,
      extra: "{}",
      position,
      is_favorite: 0,
      is_trash: 0,
      deleted_at: null,
      created_at: t,
      updated_at: t,
    };
  },

  async rename(id: string, name: string): Promise<void> {
    const d = await getDb();
    await d.execute("UPDATE views SET name = $1, updated_at = $2 WHERE id = $3", [
      name,
      now(),
      id,
    ]);
  },

  async setIcon(id: string, icon: string | null): Promise<void> {
    const d = await getDb();
    await d.execute("UPDATE views SET icon = $1, updated_at = $2 WHERE id = $3", [
      icon,
      now(),
      id,
    ]);
  },

  async setFavorite(id: string, favorite: boolean): Promise<void> {
    const d = await getDb();
    await d.execute("UPDATE views SET is_favorite = $1, updated_at = $2 WHERE id = $3", [
      favorite ? 1 : 0,
      now(),
      id,
    ]);
  },

  /** 软删：视图及其整个子树进回收站 */
  async softDelete(id: string): Promise<void> {
    const d = await getDb();
    await d.execute(
      `WITH RECURSIVE sub(id) AS (
         SELECT id FROM views WHERE id = $1
         UNION ALL
         SELECT v.id FROM views v JOIN sub ON v.parent_id = sub.id
       )
       UPDATE views SET is_trash = 1, deleted_at = $2 WHERE id IN (SELECT id FROM sub)`,
      [id, now()],
    );
  },

  /** 恢复：视图及其子树移出回收站 */
  async restore(id: string): Promise<void> {
    const d = await getDb();
    await d.execute(
      `WITH RECURSIVE sub(id) AS (
         SELECT id FROM views WHERE id = $1
         UNION ALL
         SELECT v.id FROM views v JOIN sub ON v.parent_id = sub.id
       )
       UPDATE views SET is_trash = 0, deleted_at = NULL WHERE id IN (SELECT id FROM sub)`,
      [id],
    );
  },

  /** 彻底删除：子树递归硬删（documents/database_* 经 FK 级联） */
  async purge(id: string): Promise<void> {
    const d = await getDb();
    await d.execute(
      `WITH RECURSIVE sub(id) AS (
         SELECT id FROM views WHERE id = $1
         UNION ALL
         SELECT v.id FROM views v JOIN sub ON v.parent_id = sub.id
       )
       DELETE FROM views WHERE id IN (SELECT id FROM sub)`,
      [id],
    );
  },

  async purgeTrash(workspaceId: string): Promise<void> {
    const d = await getDb();
    await d.execute("DELETE FROM views WHERE workspace_id = $1 AND is_trash = 1", [workspaceId]);
  },

  /**
   * 移动视图：重设父级并按目标位置重排两侧兄弟。
   * 防呆：目标不能是自身的后代（UI 已拦截，此处兜底）。
   */
  async move(viewId: string, newParentId: string | null, index: number): Promise<void> {
    const d = await getDb();
    const views = await d.select<View[]>(
      "SELECT * FROM views WHERE workspace_id = (SELECT workspace_id FROM views WHERE id = $1)",
      [viewId],
    );
    if (newParentId) {
      // 兜底：禁止拖入自身后代（UI 已拦截，此处防御）
      let cursor: string | null = newParentId;
      while (cursor) {
        if (cursor === viewId) return;
        cursor = views.find((v) => v.id === cursor)?.parent_id ?? null;
      }
    }
    const updates = computeRenumber(views, viewId, newParentId, index);
    if (updates.length === 0) return;
    for (const u of updates) {
      await d.execute("UPDATE views SET parent_id = $1, position = $2, updated_at = $3 WHERE id = $4", [
        u.parent_id,
        u.position,
        now(),
        u.id,
      ]);
    }
  },

  /** 获取当前应用的工作区标识（app_settings 键值，供 store 恢复） */
  async getSetting(key: string): Promise<string | null> {
    const d = await getDb();
    const rows = await d.select<{ value: string }[]>(
      "SELECT value FROM app_settings WHERE key = $1",
      [key],
    );
    return rows[0]?.value ?? null;
  },

  async setSetting(key: string, value: string): Promise<void> {
    const d = await getDb();
    await d.execute(
      "INSERT INTO app_settings(key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = $2",
      [key, value],
    );
  },
};
