import type { AiEditAnchor, AiEditOp, AiWriteCall } from "@/lib/ai-edit";
import { resolvePage, runWriteAction } from "@/lib/ai-tools";
import { applyEditToDocJson, asDoc } from "@/lib/ai/ai-locate";
import { documentApi } from "@/lib/doc/documents";
import { logger } from "@/lib/logger";
import { t } from "@/lib/i18n";
import type { JSONContent } from "@tiptap/core";
import type { ViewNode } from "@/types/models";
import type { AiActionRecord } from "./types";
import { LOCATE_REASON, bridgeFor, editorTarget } from "./ops";

// 定位与落地这一组动作构件：都不读 store 状态（编辑器桥接与当前页由 ops 里那两个读取器给），
// 因此放在 create 的闭包外面，index 里按同名导入使用。

/**
 * 对非当前页做定位编辑：save=false 只演练一遍（取 diff 用的改前原文、判断能不能定位到）。
 * JSON 路径没有编辑器事务栈，这样落地的改动无法在界面上「撤销」。
 */
const editOnPage = async (
  node: ViewNode,
  op: AiEditOp,
  markdown: string,
  anchor: AiEditAnchor | undefined,
  save: boolean,
): Promise<{ ok: boolean; before: string; reason?: string }> => {
  try {
    const raw = await documentApi.get(node.id);
    const doc: JSONContent = raw ? asDoc(JSON.parse(raw) as JSONContent | JSONContent[]) : { type: "doc", content: [] };
    const result = applyEditToDocJson(doc, op, markdown, anchor);
    if (!result.ok) return { ok: false, before: "", reason: t(LOCATE_REASON[result.reason]) };
    if (save) await documentApi.save(node.id, JSON.stringify({ ...doc, content: result.content }));
    return { ok: true, before: result.before };
  } catch (e) {
    logger.error("ai cross-page edit failed", node.id, e);
    return { ok: false, before: "", reason: e instanceof Error ? e.message : String(e) };
  }
};

/** 动作落点与可行性预览：blocked 非空表示这条动作根本执行不了 */
export const previewAction = async (
  call: AiWriteCall,
): Promise<{ before: string; pageName: string; blocked?: string }> => {
  if (call.tool !== "apply_edit") {
    const ref =
      call.tool === "create_page"
        ? call.args.parent_page
        : call.tool === "set_page_title"
          ? call.args.page
          : call.args.database;
    if (!ref) return { before: "", pageName: "" };
    const node = resolvePage(ref);
    if (!node) return { before: "", pageName: "", blocked: t("ai.toolPageNotFound", { ref }) };
    return { before: "", pageName: node.name };
  }
  const { op, content, anchor, view_id } = call.args;
  const { bridge, currentId } = editorTarget();
  const target = bridgeFor(view_id, bridge, currentId);
  if (target) {
    return { before: target.getEditTargetText(op, anchor), pageName: target.getPageTitle() };
  }
  if (!view_id) return { before: "", pageName: "", blocked: t("ai.noEditor") };
  const node = resolvePage(view_id);
  if (!node) return { before: "", pageName: "", blocked: t("ai.toolPageNotFound", { ref: view_id }) };
  const dry = await editOnPage(node, op, content, anchor, false);
  return { before: dry.before, pageName: node.name, ...(dry.reason ? { blocked: dry.reason } : {}) };
};

/** 真正执行一个动作：当前页走编辑器事务（可撤销），其它页面与库写入走各自路径 */
export const landAction = async (rec: AiActionRecord): Promise<AiActionRecord> => {
  const call = rec.call;
  if (!call) return { ...rec, state: "unavailable" };
  if (call.tool === "apply_edit") {
    const { op, content, anchor, view_id } = call.args;
    const { bridge, currentId } = editorTarget();
    // 打开中的页面（含分栏副栏）必须走编辑器事务：JSON 直写会被该实例自动保存覆盖回去
    const target = bridgeFor(view_id, bridge, currentId);
    if (target) {
      const result = target.applyEdit(op, content, anchor);
      return result.applied
        ? { ...rec, state: "applied", revert: result.revert }
        : { ...rec, state: "unavailable", detail: result.reason ?? t("ai.editNotApplied") };
    }
    if (!view_id) return { ...rec, state: "unavailable", detail: t("ai.noEditor") };
    const node = resolvePage(view_id);
    if (!node) return { ...rec, state: "unavailable", detail: t("ai.toolPageNotFound", { ref: view_id }) };
    const done = await editOnPage(node, op, content, anchor, true);
    if (done.ok) return { ...rec, state: "applied", pageName: node.name };
    return { ...rec, state: "unavailable", pageName: node.name, detail: done.reason };
  }
  const outcome = await runWriteAction(call);
  if (outcome.ok) {
    return {
      ...rec,
      state: "applied",
      detail: outcome.detail,
      // 换逆操作计划要换掉旧的：上一次落地留下的计划撤销的是上一次的改动
      ...(outcome.undo ? { undo: outcome.undo } : {}),
    };
  }
  return { ...rec, state: "unavailable", detail: outcome.detail };
};
