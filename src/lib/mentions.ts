import { getDb, newId, runInTransaction } from "./db";
import type { JSONContent } from "@tiptap/core";
import { logger } from "./logger";

// 双链反链索引表（migrations 003_mentions.sql）：保存文档时把所有 mention 节点落库，
// 反链查询从 EditorPage.tsx 的"N 次 DB 查询 + 递归 JSON"优化为单条 SQL。

/** 反链条目：来自 mentions 表一行，已按 src_view_id 分组前的原始行 */
export interface MentionRow {
  id: string;
  src_view_id: string;
  target_view_id: string;
  context_text: string | null;
  updated_at: number;
}

/** 在文档 JSON 中递归收集所有 mention 节点 + 其所在 paragraph 的前后文片段 */
interface CollectedMention {
  targetId: string;
  context: string;
}

const CONTEXT_RADIUS = 30;

/**
 * 递归遍历 JSON 找 type==='mention' 节点，并取其所在块（paragraph/heading 等）的
 * 纯文本前后 30 字作为 context_text。参考 EditorPage.tsx 旧 countMentionsTo 的递归形态。
 */
function collectMentions(node: JSONContent, parentBlockText: string | null): CollectedMention[] {
  const out: CollectedMention[] = [];
  if (!node) return out;

  // 当前块级文本：paragraph/heading 等含 text 子节点，提取后传给子节点做 context
  let currentBlockText = parentBlockText;
  if (node.type === "paragraph" || node.type === "heading" || node.type === "blockquote" || node.type === "listItem" || node.type === "taskItem") {
    currentBlockText = collectText(node);
  }

  // 命中 mention 节点
  if (node.type === "mention" && typeof node.attrs?.id === "string") {
    const targetId = node.attrs.id as string;
    const label = typeof node.attrs?.label === "string" ? node.attrs.label : "";
    const ctx = currentBlockText ?? label;
    // 截前后 30 字（mention 节点本身可能不在 textContent 中，截整个块文本即可）
    const trimmed = ctx.length > CONTEXT_RADIUS * 2 + 3
      ? ctx.slice(0, CONTEXT_RADIUS) + "…" + ctx.slice(-CONTEXT_RADIUS)
      : ctx;
    out.push({ targetId, context: trimmed || label });
  }

  // 递归子节点
  if (node.content) {
    for (const child of node.content) {
      out.push(...collectMentions(child, currentBlockText));
    }
  }
  return out;
}

/** 取一个块级节点的纯文本（拼接所有 text 子节点） */
function collectText(node: JSONContent): string {
  if (!node) return "";
  if (typeof node.text === "string") return node.text;
  if (!node.content) return "";
  return node.content.map(collectText).join("");
}

export const mentionsApi = {
  /**
   * 重建某文档对应的 mentions 行：先删 src_view_id=? 的旧记录，再扫描 json 写新记录。
   * 在事务内执行避免半完成状态；调用方失败仅 console.warn 不阻断保存。
   */
  async rebuildFor(viewId: string, json: JSONContent): Promise<void> {
    const collected = collectMentions(json, null);
    const t = Date.now();
    await runInTransaction(async (d) => {
      await d.execute("DELETE FROM mentions WHERE src_view_id = $1", [viewId]);
      for (const m of collected) {
        // 过滤自引用：targetId === viewId 不入库，避免反链列表出现自己指向自己
        if (m.targetId === viewId) continue;
        const id = newId();
        await d.execute(
          `INSERT INTO mentions(id, src_view_id, target_view_id, context_text, updated_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [id, viewId, m.targetId, m.context, t],
        );
      }
    });
  },

  /**
   * 反链查询：返回 target_view_id 被引用的全部行，按更新时间倒序。
   * 调用方按 src_view_id 分组、每组最多保留 3 条 context。
   */
  async listBacklinks(targetViewId: string): Promise<MentionRow[]> {
    const d = await getDb();
    return d.select<MentionRow[]>(
      "SELECT id, src_view_id, target_view_id, context_text, updated_at FROM mentions WHERE target_view_id = $1 ORDER BY updated_at DESC",
      [targetViewId],
    );
  },

  /** 一次性回填：应用启动时若 mentions 表为空，遍历所有文档重建。
   *
   * Phase 4 优化 · P2#3：分批（BATCH=8 篇/tick）并 `await sleep(10)`，
   * 避免大 workspace（> 500 篇文档）启动时主线程阻塞、用户看到 UI 冻结。
   */
  async backfillIfEmpty(): Promise<void> {
    const d = await getDb();
    const countRows = await d.select<{ c: number }[]>("SELECT COUNT(*) AS c FROM mentions");
    const count = countRows[0]?.c ?? 0;
    if (count > 0) return;

    // 旧数据库升级路径：扫描所有 documents 表
    const docs = await d.select<{ view_id: string; content: string }[]>(
      "SELECT view_id, content FROM documents",
    );
    if (docs.length === 0) return;

    const BATCH = 8;
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    for (let i = 0; i < docs.length; i += BATCH) {
      const batch = docs.slice(i, i + BATCH);
      for (const doc of batch) {
        try {
          const json = JSON.parse(doc.content) as JSONContent;
          await mentionsApi.rebuildFor(doc.view_id, json);
        } catch (e) {
          logger.warn("mentions.backfill", "backfill mentions skipped", doc.view_id, e);
        }
      }
      // 小批次之间让一帧，避免长时间占满 microtask 队列
      await sleep(10);
    }
  },
};
