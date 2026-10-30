// 页面类写动作：建页（首行 H1 + 分割线 + 正文，与页面模板同构，结构锁定依赖这个形状）与改标题。

import type { JSONContent } from "@tiptap/core";
import { appReload, appRenameView, appViewId, appWorkspaceId } from "../app-context";
import { markdownToNodes } from "../ai/ai-locate";
import { viewApi } from "../backend/db";
import { documentApi } from "../doc/documents";
import { t } from "../i18n";
import { logger } from "../logger";
import { resolvePage } from "./resolve-page";
import type { WriteOutcome } from "./undo-plan";

function newDocumentJson(title: string, contentMarkdown: string): JSONContent {
  // 与页面模板同构：首行 H1 标题 + 分割线 + 正文，结构锁定依赖这个形状
  return {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: title }] },
      { type: "horizontalRule" },
      ...markdownToNodes(contentMarkdown),
    ],
  };
}

export async function createPage(args: {
  title: string;
  content?: string;
  parent_page?: string;
}): Promise<WriteOutcome> {
  const workspaceId = appWorkspaceId();
  if (!workspaceId) return { ok: false, detail: t("ai.toolNoWorkspace") };
  let parentId: string | null = null;
  let parentName = "";
  if (args.parent_page) {
    const parent = resolvePage(args.parent_page);
    if (!parent) return { ok: false, detail: t("ai.toolPageNotFound", { ref: args.parent_page }) };
    parentId = parent.id;
    parentName = parent.name;
  } else {
    const currentViewId = appViewId();
    if (currentViewId) {
      // 未指定父页面：挂在当前页之下（就地建子页），没有当前页则建在根
      parentId = currentViewId;
      parentName = resolvePage(currentViewId)?.name ?? "";
    }
  }
  const view = await viewApi.create({
    workspace_id: workspaceId,
    parent_id: parentId,
    name: args.title,
    layout: "document",
  });
  try {
    await documentApi.save(view.id, JSON.stringify(newDocumentJson(args.title, args.content ?? "")));
  } catch (e) {
    logger.error("ai-tools: save new page failed", view.id, e);
    return { ok: false, detail: t("ai.actionCreateFailed", { title: args.title }) };
  }
  await appReload();
  return {
    ok: true,
    detail: t("ai.actionCreated", {
      title: args.title,
      parent: parentId ? t("ai.actionCreatedChild", { name: parentName }) : t("ai.actionCreatedRoot"),
    }),
    id: view.id,
    // 撤销 AI 建的页 = 进回收站（软删），与用户手动删页同一条语义：还能再找回，不是二次销毁
    undo: { kind: "remove_view", view_id: view.id },
  };
}

export async function setPageTitle(args: { page: string; title: string }): Promise<WriteOutcome> {
  const node = resolvePage(args.page);
  if (!node) return { ok: false, detail: t("ai.toolPageNotFound", { ref: args.page }) };
  await appRenameView(node.id, args.title);
  return {
    ok: true,
    detail: t("ai.actionRenamed", { from: node.name, to: args.title }),
    undo: { kind: "rename_view", view_id: node.id, name: node.name },
  };
}
