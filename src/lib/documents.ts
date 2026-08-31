import { getDb } from "./db";

// 文档读写（项目说明书 8.1 节：TipTap JSON 整篇存 documents.content）。
// 所有写操作按 view 串行化：防抖保存与切页 flush 交错时不会乱序。

const queues = new Map<string, Promise<void>>();

async function saveNow(viewId: string, content: string): Promise<void> {
  const d = await getDb();
  await d.execute(
    `INSERT INTO documents(view_id, content, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT(view_id) DO UPDATE SET content = $2, updated_at = $3`,
    [viewId, content, Date.now()],
  );
}

export const documentApi = {
  /** 读取文档 JSON 字符串；无行返回 null */
  async get(viewId: string): Promise<string | null> {
    const d = await getDb();
    const rows = await d.select<{ content: string }[]>(
      "SELECT content FROM documents WHERE view_id = $1",
      [viewId],
    );
    return rows[0]?.content ?? null;
  },

  /** 保存文档；同一 view 的写操作按序执行 */
  save(viewId: string, content: string): Promise<void> {
    const prev = queues.get(viewId) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined) // 前序失败不阻断本次保存
      .then(() => saveNow(viewId, content));
    queues.set(viewId, next);
    return next;
  },
};
