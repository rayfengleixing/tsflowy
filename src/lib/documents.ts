import { getDb, withWriteLock } from "./db";
import { mentionsApi } from "./mentions";
import { logger } from "./logger";

// 文档读写（项目说明书 8.1 节：TipTap JSON 整篇存 documents.content）。
//
// Phase 4 优化 · P2#2（mailbox 合并排队）：
//   同一 view 的保存请求如果在"前一次 save 实际开始执行"之前快速来了 N 次，
//   仅保留最后一次 content 作为真正落库的 payload，其余中间态直接丢弃。
//   这避免了快速输入时：防抖没覆盖到 → 5 次排队都跑 DB + JSON.parse + mentions.rebuildFor。
//
//   数据结构：
//     running   = Map<viewId, Promise<void>>  当前正在跑（或已挂起等待的）save 任务
//     mailboxes = Map<viewId, string>          在运行期间到达的最新一份 content（单格）

const running = new Map<string, Promise<void>>();
const mailboxes = new Map<string, string>();

async function saveNow(viewId: string, content: string): Promise<void> {
  return withWriteLock(async () => {
    const d = await getDb();
    await d.execute(
      `INSERT INTO documents(view_id, content, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT(view_id) DO UPDATE SET content = $2, updated_at = $3`,
      [viewId, content, Date.now()],
    );
    // 同步重建 mentions 索引（Phase 2.1）。失败仅 warn 不阻断保存。
    try {
      const json = JSON.parse(content);
      await mentionsApi.rebuildFor(viewId, json);
    } catch (e) {
      logger.warn("documents.save", "mentions rebuild skipped", viewId, e);
    }
  });
}

/**
 * 运行（或排入单格 mailbox）一次 save。
 * ·若 view 空闲：立刻执行 saveNow，运行期间收集的 mail 全部合入最后一次。
 * ·若 view 忙：写入 mail 覆盖旧值，运行结束时只执行最新一次。
 */
async function runOrEnqueue(viewId: string, content: string): Promise<void> {
  const current = running.get(viewId);
  if (!current) {
    // 空闲 → 立刻启动执行
    const worker = (async () => {
      // 每次运行结束，查 mailbox；若有新内容则接着用最新 content 继续跑下一轮（循环直到 mail 空）
      let latest = content;
      let more = true;
      while (more) {
        let done = false;
        try {
          await saveNow(viewId, latest);
        } finally {
          // 跑完一圈，尝试取 mail；没有就结束循环
          const next = mailboxes.get(viewId);
          if (next === undefined) {
            running.delete(viewId);
            // 在 finally 内不能 break/return（ESLint no-unsafe-finally），
            // 用两个标志位把退出挪到循环体后。
            more = false;
            done = true;
          } else {
            latest = next;
            mailboxes.delete(viewId);
          }
        }
        if (done) break;
      }
    })();
    running.set(viewId, worker);
    return worker;
  }
  // 忙：把最新内容写 mail（覆盖旧的），并返回同一个 running Promise，
  // 使调用方 await 语义依然是「等最新一次保存完成或前次完成」。
  mailboxes.set(viewId, content);
  return current;
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

  /** 保存文档；同一 view 的多次请求会合并到最后一份内容落库。 */
  save(viewId: string, content: string): Promise<void> {
    return runOrEnqueue(viewId, content);
  },
};
