import { useMemo } from "react";
import { ChevronRight } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { viewIcon } from "@/components/view-icon";
import { useWorkspaceStore } from "@/stores/workspace";
import { findNode } from "@/lib/tree";
import { t } from "@/lib/i18n";
import type { ViewNode } from "@/types/models";

/**
* 面包屑（Phase 3.2）：在 TabBar 下方一行展示当前视图的父级链。
* 点击任意祖先 → openView 该祖先；当前节点不可点（已是当前页）。
*
* 数据源：workspace store 的 tree + currentViewId，本地走父级链；无父级时仅显示根占位。
* 渲染：高度 28px，左对齐，溢出省略；与 TabBar 同色系（neutral-100/white）。
*/
export function Breadcrumb() {
const { tree, currentViewId, route, openView } = useWorkspaceStore(
useShallow((s) => ({ tree: s.tree, currentViewId: s.currentViewId, route: s.route, openView: s.openView })),
);

// 仅在 workspace 路由（编辑/数据库视图）显示；trash/settings/search 不需要面包屑
const visible = route === "workspace" && currentViewId !== null;

// 从 currentViewId 向上走 parent_id 链，构造 [根→...→当前] 数组
const chain = useMemo<ViewNode[]>(() => {
if (!currentViewId) return [];
const node = findNode(tree, currentViewId);
if (!node) return [];
const list: ViewNode[] = [node];
let cursor = node.parent_id;
const safetyMax = 32; // 防御：循环引用兜底
let i = 0;
while (cursor && i++ < safetyMax) {
const parent = findNode(tree, cursor);
if (!parent) break;
list.unshift(parent);
cursor = parent.parent_id;
}
return list;
}, [tree, currentViewId]);

// 只显示祖先链（不含当前页），避免与 TabBar / 顶栏标题重复
const ancestors = chain.length > 1 ? chain.slice(0, -1) : [];
if (!visible || ancestors.length === 0) return null;

return (
<nav
aria-label="breadcrumb"
className="flex h-7 shrink-0 items-stretch border-b border-neutral-200 bg-neutral-50 px-3 text-[12px] text-neutral-500"
>
<ol className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto whitespace-nowrap">
{ancestors.map((node, idx) => (
<li key={node.id} className="flex items-center gap-0.5">
{idx > 0 && <ChevronRight className="h-3 w-3 shrink-0 text-neutral-300" />}
<button
type="button"
className="flex items-center gap-1 rounded px-1 py-0.5 text-neutral-500 transition hover:bg-neutral-200/60 hover:text-neutral-800"
onClick={() => openView(node.id)}
title={node.name}
>
<span className="flex w-4 shrink-0 items-center justify-center text-neutral-500">
{viewIcon(node)}
</span>
<span className="max-w-[160px] truncate">{node.name || t("common.untitled")}</span>
</button>
</li>
))}
</ol>
</nav>
);
}
