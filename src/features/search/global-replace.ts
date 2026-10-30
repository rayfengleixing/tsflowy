// 跨页/全局替换的编排层。
//
// 候选页来自 Rust 的 doc_ids_matching（正文纯文本字面含有查询词的视图，回收站除外），
// 改写分两条路，语义刻意对齐 lib/text-replace.ts 的那条：
//   - 页面正开着（主栏或分栏任一面板）：走编辑器事务，用户能 Ctrl+Z 逐页回退，
//     且不会与编辑器内存态互相覆盖（同一个文档可能同时开在两栏，每个实例都要改到）；
//   - 页面没开：读库 → JSON 层改写 → documentApi.save（落库时 Rust 侧会按节流策略存历史快照）。
// 首个标题块是页面标题（views.name 的镜像），两条路都跳过它，只如实计数。
import type { Editor } from "@tiptap/core";
import type { JSONContent } from "@tiptap/core";

import { countReplaceableInDoc, replaceAllInDoc } from "@/features/editor/extensions/find-replace";
import { asDoc } from "@/lib/ai/ai-locate";
import { documentApi } from "@/lib/doc/documents";
import { invoke } from "@/lib/invoke";
import { logger } from "@/lib/logger";
import { replaceInDocContent, type ReplaceOptions } from "@/lib/search/text-replace";
import { getDocEditors } from "@/stores/editor";

export interface ReplacePageReport {
  viewId: string;
  title: string;
  /** 实际改写（dryRun 时为「将会改写」）处数 */
  replaced: number;
  /** 文字里出现了，但横跨多个内联段，批量改写不碰它——交回页面内 Ctrl+F 处理 */
  crossFormat: number;
  /** 落在页面标题上的命中数，永不改写 */
  protectedTitle: number;
}

export interface GlobalReplaceReport {
  pages: ReplacePageReport[];
  replaced: number;
  crossFormat: number;
  protectedTitle: number;
  /** 候选页数（含改写后为 0 的页面，用于进度与「无处数变化」的判断） */
  candidates: number;
  /** 用户中途取消：pages 与计数只覆盖已经跑到的那几页 */
  stopped: boolean;
}

export interface GlobalReplaceArgs {
  workspaceId: string;
  search: string;
  replace: string;
  options?: ReplaceOptions;
  /** true 只统计不改库，供「预览」按钮用 */
  dryRun: boolean;
  onProgress?: (done: number, total: number) => void;
  /** 每页开始前询问；返回 true 就停在当前进度上（已改写的页面不回滚） */
  isCancelled?: () => boolean;
}

interface MatchedDocOut {
  view_id: string;
  title: string;
}

const emptyCounts = (): Pick<ReplacePageReport, "replaced" | "crossFormat" | "protectedTitle"> => ({
  replaced: 0,
  crossFormat: 0,
  protectedTitle: 0,
});

/** 关着的页面：JSON 层预览或改写 */
async function handleClosedPage(args: GlobalReplaceArgs, viewId: string, title: string): Promise<ReplacePageReport> {
  const options = args.options ?? {};
  const raw = await documentApi.get(viewId);
  if (!raw) return { viewId, title, ...emptyCounts() };
  let doc: JSONContent;
  try {
    doc = JSON.parse(raw) as JSONContent;
  } catch (e) {
    logger.warn("global-replace", "文档 JSON 解析失败，跳过", viewId, e);
    return { viewId, title, ...emptyCounts() };
  }
  const root = asDoc(doc);
  const content = Array.isArray(root.content) ? root.content : [];
  const result = replaceInDocContent(content, args.search, args.replace, options);
  const changed = result.counts.replaced > 0 && !args.dryRun;
  if (changed) await documentApi.save(viewId, JSON.stringify({ ...root, content: result.content }));
  return { viewId, title, ...result.counts };
}

/** 打开着的页面：以第一个实例的改动数为准（同页多栏内容相同），其余实例逐个跟上防止覆盖 */
function handleLivePage(editors: Editor[], args: GlobalReplaceArgs, viewId: string, title: string): ReplacePageReport {
  const options = args.options ?? {};
  const caseSensitive = options.caseSensitive === true;
  const wholeWord = options.wholeWord === true;
  const first = editors[0];
  if (args.dryRun) {
    const replaced = countReplaceableInDoc(first, args.search, { caseSensitive, wholeWord });
    return { viewId, title, replaced, crossFormat: 0, protectedTitle: 0 };
  }
  let replaced = 0;
  for (const editor of editors) {
    const n = replaceAllInDoc(editor, args.search, args.replace, { caseSensitive, wholeWord });
    if (replaced === 0) replaced = n;
  }
  return { viewId, title, replaced, crossFormat: 0, protectedTitle: 0 };
}

function summarize(pages: ReplacePageReport[], candidates: number, stopped = false): GlobalReplaceReport {
  return {
    pages,
    candidates,
    stopped,
    replaced: pages.reduce((acc, p) => acc + p.replaced, 0),
    crossFormat: pages.reduce((acc, p) => acc + p.crossFormat, 0),
    protectedTitle: pages.reduce((acc, p) => acc + p.protectedTitle, 0),
  };
}

/**
 * 在本空间执行一次全局替换（或仅预览）。
 * 逐页串行：一次 IPC 读 + 一次写，进度回调供 UI 显示「第 n / N 页」；
 * 单页失败（读不到、JSON 坏、IPC 报错）只跳过该页，不影响其余页面已经完成的改写。
 */
export async function runGlobalReplace(args: GlobalReplaceArgs): Promise<GlobalReplaceReport> {
  if (!args.search) return summarize([], 0);
  const candidates = await invoke<MatchedDocOut[]>("doc_ids_matching", {
    workspaceId: args.workspaceId,
    needle: args.search,
  });
  const pages: ReplacePageReport[] = [];
  let done = 0;
  let stopped = false;
  for (const cand of candidates) {
    if (args.isCancelled?.()) {
      stopped = true;
      break;
    }
    let report: ReplacePageReport;
    try {
      const editors = getDocEditors(cand.view_id).filter((ed) => !ed.isDestroyed);
      report =
        editors.length > 0
          ? handleLivePage(editors, args, cand.view_id, cand.title)
          : await handleClosedPage(args, cand.view_id, cand.title);
    } catch (e) {
      logger.warn("global-replace", "单页处理失败，跳过", cand.view_id, e);
      report = { viewId: cand.view_id, title: cand.title, ...emptyCounts() };
    }
    if (report.replaced > 0 || report.crossFormat > 0 || report.protectedTitle > 0) pages.push(report);
    done++;
    args.onProgress?.(done, candidates.length);
  }
  return summarize(pages, candidates.length, stopped);
}
