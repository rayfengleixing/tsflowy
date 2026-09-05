import { invoke } from "@tauri-apps/api/core";
import { newId } from "./db";
import type { JSONContent } from "@tiptap/core";
import { logger } from "./logger";
import type { View } from "@/types/models";

// 双链反链索引表（migrations 003_mentions.sql）：保存文档时把所有 mention 节点落库，
// 反链查询从 EditorPage.tsx 的"N 次 DB 查询 + 递归 JSON"优化为单条 SQL。
// 持久化走 Rust 领域命令（mention_rebuild / mention_list_backlinks / mention_count）。

/** 反链条目：来自 mentions 表一行，已按 src_view_id 分组前的原始行 */
export interface MentionRow {
  id: string;
  src_view_id: string;
  target_view_id: string;
  context_text: string | null;
  updated_at: number;
}

/** 反链查询行：Rust JOIN 带出完整来源视图，免调用方逐条 viewApi.get（旧 N+1） */
export interface BacklinkRow extends MentionRow {
  src_view: View;
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
  if (
    node.type === "paragraph" ||
    node.type === "heading" ||
    node.type === "blockquote" ||
    node.type === "listItem" ||
    node.type === "taskItem"
  ) {
    currentBlockText = collectText(node);
  }

  // 命中 mention 节点
  if (node.type === "mention" && typeof node.attrs?.id === "string") {
    const targetId = node.attrs.id;
    const label = typeof node.attrs?.label === "string" ? node.attrs.label : "";
    const ctx = currentBlockText ?? label;
    // 截前后 30 字（mention 节点本身可能不在 textContent 中，截整个块文本即可）
    const trimmed =
      ctx.length > CONTEXT_RADIUS * 2 + 3 ? ctx.slice(0, CONTEXT_RADIUS) + "…" + ctx.slice(-CONTEXT_RADIUS) : ctx;
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
   * 重建某文档对应的 mentions 行：Rust 侧单事务先删 src_view_id=? 的旧记录，再整批写入新行。
   * 自引用过滤（targetId === viewId）与 id 生成在此处完成；
   * 注意 rows 元素必须传 snake_case 键（Rust MentionRowIn 按声明字段名反序列化）。
   * 调用方失败仅 logger.warn 不阻断保存。
   */
  async rebuildFor(viewId: string, json: JSONContent): Promise<void> {
    const collected = collectMentions(json, null);
    const rows = collected
      .filter((m) => m.targetId !== viewId)
      .map((m) => ({ id: newId(), target_view_id: m.targetId, context_text: m.context }));
    await invoke("mention_rebuild", { viewId, rows });
  },

  /**
   * 反链查询：返回 target_view_id 被引用的全部行（含来源视图完整行），按更新时间倒序。
   * 调用方按 src_view_id 分组、每组最多保留 3 条 context。
   */
  async listBacklinks(targetViewId: string): Promise<BacklinkRow[]> {
    return invoke<BacklinkRow[]>("mention_list_backlinks", { targetViewId });
  },

  /** 一次性回填：应用启动时若 mentions 表为空，遍历所有文档重建。
   *
   * Phase 4 优化 · P2#3：分批（BATCH=8 篇/tick）并 `await sleep(10)`，
   * 避免大 workspace（> 500 篇文档）启动时主线程阻塞、用户看到 UI 冻结。
   */
  async backfillIfEmpty(): Promise<void> {
    const count = await invoke<number>("mention_count");
    if (count > 0) return;

    // 旧数据库升级路径：扫描所有 documents 表
    const docs = await invoke<{ view_id: string; content: string }[]>("doc_list_all");
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
