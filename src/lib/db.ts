import Database from "@tauri-apps/plugin-sql";
import type { LayoutType, View, Workspace } from "@/types/models";
import { computeRenumber } from "@/lib/tree";

// 所有 SQL 集中在本模块（项目说明书 9.3 节），组件不直接拼 SQL。

let db: Database | null = null;

/**
 * 全局写锁：tauri-plugin-sql 内部使用连接池，每条 execute 可能走不同连接。
 * 若 BEGIN 在连接 A、INSERT 在连接 B，B 拿不到写锁 → SQLITE_BUSY (code 5)。
 * 用 Promise 链序列化所有写操作，确保同一时刻只有一个写操作在执行。
 *
 * 可重入：documents.saveNow 在 withWriteLock 内调用 mentions.rebuildFor，
 * 后者走 runInTransaction → withWriteLock。若不可重入会死锁
 * （内层等外层 fn 完成，外层 fn 等内层完成）。检测到已在写锁内则直接执行不再排队。
 */
let _writeChain: Promise<unknown> = Promise.resolve();
let _writeDepth = 0;

export function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  // 可重入：已在写锁内（同一次调用栈）则直接执行，避免嵌套死锁
  if (_writeDepth > 0) return fn();
  const prev = _writeChain;
  let release: () => void = () => {};
  _writeChain = new Promise<void>((r) => { release = r; });
  _writeDepth++;
  return prev.then(() => fn()).finally(() => { _writeDepth--; release(); });
}

export async function getDb(): Promise<Database> {
  if (!db) {
    const inst = await Database.load("sqlite:appflowy.db");

    // Phase 4 优化 · P0 #2：启用 SQLite 最佳实践
    // 顺序：journal_mode → 其余 pragma（synchronous 依赖 journal_mode 生效）
    const pragmas: Array<[string, unknown[]?]> = [
      // WAL = 写入并发 + 崩溃安全；断电风险极低的桌面程序首选
      ["PRAGMA journal_mode=WAL"],
      // NORMAL 在 WAL 下兼顾性能与 ACID（崩溃丢最多最近一次事务写入，足够）
      ["PRAGMA synchronous=NORMAL"],
      // 并发写等待 10s 而非直接返回 SQLITE_BUSY（从 5s 提升）
      ["PRAGMA busy_timeout=10000"],
      // 临时表/排序放内存（不占磁盘 I/O，仅对大 ORDER BY 生效）
      ["PRAGMA temp_store=MEMORY"],
      // 启用外键（tauri-plugin-sql 有的连接默认关闭；迁移里 001 已在事务里打开，但每条连接都要强制）
      ["PRAGMA foreign_keys=ON"],
      // cache_size = 页（通常 4KB）× 10000 ≈ 40 MB，足够 500MB 数据库热页命中
      ["PRAGMA cache_size=-10000"],
    ];
    for (const [p, args] of pragmas) {
      try {
        // tauri-plugin-sql: Database 只有 select/execute，pragma 用 select 可带回结果。
        // 对 journal_mode 我们不校验（Tauri + rusqlite 在某些 Windows 下会返回 memory 也 OK）
        if (args?.length) await inst.select(p, args);
        else await inst.select(p);
      } catch (e) {
        // PRAGMA 失败不致命；但至少 warn 一下
        console.warn("[db] pragma apply failed", p, e);
      }
    }
    db = inst;
  }
  return db;
}

/**
 * SQLite 简易事务 helper：BEGIN → 运行 fn → COMMIT；fn 抛异常则 ROLLBACK。
 * 警告：tauri-plugin-sql 每条 execute 自动 commit（它内部用的是 rusqlite 的 auto-commit 连接），
 * 所以需要显式 BEGIN/COMMIT 包裹；嵌套调用会失败（SQLite 不支持真实嵌套事务），
 * 调用方应避免嵌套 runInTransaction。
 */
export async function runInTransaction<T>(
  fn: (d: Database) => Promise<T>,
): Promise<T> {
  return withWriteLock(async () => {
    const d = await getDb();
    await d.execute("BEGIN");
    try {
      const result = await fn(d);
      await d.execute("COMMIT");
      return result;
    } catch (e) {
      try { await d.execute("ROLLBACK"); } catch { /* ignore rollback failure */ }
      throw e;
    }
  });
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
  // 排除行详情视图（说明书 12 节风险 7：extra 标记 {"row_detail":true}）
  async listByWorkspace(workspaceId: string): Promise<View[]> {
    const d = await getDb();
    return d.select<View[]>(
      "SELECT * FROM views WHERE workspace_id = $1 AND is_trash = 0 AND json_extract(extra, '$.row_detail') IS NOT 1 ORDER BY position ASC",
      [workspaceId],
    );
  },

  async listTrash(workspaceId: string): Promise<View[]> {
    const d = await getDb();
    return d.select<View[]>(
      "SELECT * FROM views WHERE workspace_id = $1 AND is_trash = 1 AND json_extract(extra, '$.row_detail') IS NOT 1 ORDER BY deleted_at DESC",
      [workspaceId],
    );
  },

  async listFavorites(workspaceId: string): Promise<View[]> {
    const d = await getDb();
    return d.select<View[]>(
      "SELECT * FROM views WHERE workspace_id = $1 AND is_trash = 0 AND is_favorite = 1 AND json_extract(extra, '$.row_detail') IS NOT 1 ORDER BY position ASC",
      [workspaceId],
    );
  },

  /** 最近访问视图：按 visited_at 倒序，排除回收站/行详情（Phase 3.2 - Recent Tab） */
  async listRecent(workspaceId: string, limit = 30): Promise<View[]> {
    const d = await getDb();
    return d.select<View[]>(
      "SELECT * FROM views WHERE workspace_id = $1 AND is_trash = 0 AND visited_at IS NOT NULL AND json_extract(extra, '$.row_detail') IS NOT 1 ORDER BY visited_at DESC LIMIT $2",
      [workspaceId, limit],
    );
  },

  /** 标记视图为"最近被打开"：openView 时调用，驱动 Recent Tab 列表 */
  async touchVisited(id: string): Promise<void> {
    return withWriteLock(async () => {
      const d = await getDb();
      await d.execute("UPDATE views SET visited_at = $1 WHERE id = $2", [now(), id]);
    });
  },

  async create(opts: {
    workspace_id: string;
    parent_id: string | null;
    name: string;
    layout: LayoutType;
    extra?: string;
  }): Promise<View> {
    return withWriteLock(async () => {
      const d = await getDb();
      const id = newId();
      const t = now();
      const rows = await d.select<{ p: number }[]>(
        "SELECT COALESCE(MAX(position), -1) + 1 AS p FROM views WHERE workspace_id = $1 AND parent_id IS $2",
        [opts.workspace_id, opts.parent_id],
      );
      const position = rows[0]?.p ?? 0;
      const extra = opts.extra ?? "{}";
      await d.execute(
        `INSERT INTO views(id, workspace_id, parent_id, name, layout, extra, position, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
        [id, opts.workspace_id, opts.parent_id, opts.name, opts.layout, extra, position, t],
      );
      if (opts.layout === "document") {
        // 文档布局需预置内容行：默认第一行 H1 标题 = 文档名（需求3）
        const defaultContent = JSON.stringify({
          type: "doc",
          content: [
            {
              type: "heading",
              attrs: { level: 1 },
              content: [{ type: "text", text: opts.name }],
            },
          ],
        });
        await d.execute(
          'INSERT INTO documents(view_id, content, updated_at) VALUES ($1, $2, $3)',
          [id, defaultContent, t],
        );
      }
      return {
        id,
        workspace_id: opts.workspace_id,
        parent_id: opts.parent_id,
        name: opts.name,
        icon: null,
        layout: opts.layout,
        extra,
        position,
        is_favorite: 0,
        is_trash: 0,
        deleted_at: null,
        created_at: t,
        updated_at: t,
        visited_at: null,
      };
    });
  },

  /** 按 id 读单个视图（行详情文档等） */
  async get(id: string): Promise<View | null> {
    const d = await getDb();
    const rows = await d.select<View[]>("SELECT * FROM views WHERE id = $1", [id]);
    return rows[0] ?? null;
  },

  async rename(id: string, name: string): Promise<void> {
    return withWriteLock(async () => {
      const d = await getDb();
      await d.execute("UPDATE views SET name = $1, updated_at = $2 WHERE id = $3", [
        name,
        now(),
        id,
      ]);
    });
  },

  async setIcon(id: string, icon: string | null): Promise<void> {
    return withWriteLock(async () => {
      const d = await getDb();
      await d.execute("UPDATE views SET icon = $1, updated_at = $2 WHERE id = $3", [
        icon,
        now(),
        id,
      ]);
    });
  },

  async setFavorite(id: string, favorite: boolean): Promise<void> {
    return withWriteLock(async () => {
      const d = await getDb();
      await d.execute("UPDATE views SET is_favorite = $1, updated_at = $2 WHERE id = $3", [
        favorite ? 1 : 0,
        now(),
        id,
      ]);
    });
  },

  /** 软删：视图及其整个子树进回收站 */
  async softDelete(id: string): Promise<void> {
    return withWriteLock(async () => {
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
    });
  },

  /** 恢复：视图及其子树移出回收站 */
  async restore(id: string): Promise<void> {
    return withWriteLock(async () => {
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
    });
  },

  /** 彻底删除：子树递归硬删（documents/database_* 经 FK 级联） */
  async purge(id: string): Promise<void> {
    return withWriteLock(async () => {
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
    });
  },

  async purgeTrash(workspaceId: string): Promise<void> {
    return withWriteLock(async () => {
      const d = await getDb();
      await d.execute("DELETE FROM views WHERE workspace_id = $1 AND is_trash = 1", [workspaceId]);
    });
  },

  /** 永久删除回收站中 deleted_at 早于 deadline_ms（毫秒时间戳）的视图，用于 30 天自动清空 */
  async purgeExpiredTrash(workspaceId: string, deadline_ms: number): Promise<number> {
    return withWriteLock(async () => {
      const d = await getDb();
      const result = await d.execute(
        "DELETE FROM views WHERE workspace_id = $1 AND is_trash = 1 AND deleted_at IS NOT NULL AND deleted_at < $2",
        [workspaceId, deadline_ms],
      );
      const affected = (result as unknown as { rowsAffected?: number; rows_affected?: number }).rowsAffected
        ?? (result as unknown as { rows_affected?: number }).rows_affected;
      return affected ?? 0;
    });
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
    const t = now();
    // Phase 4 优化 · P2#6：批量重排必须原子，避免崩溃出现父子关系刷新一半
    await runInTransaction(async (tx) => {
      for (const u of updates) {
        await tx.execute("UPDATE views SET parent_id = $1, position = $2, updated_at = $3 WHERE id = $4", [
          u.parent_id,
          u.position,
          t,
          u.id,
        ]);
      }
    });
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