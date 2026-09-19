import { useRef, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronRight, MoreHorizontal, Pencil, Plus, Star, Tag, Trash2, Download } from "lucide-react";
import { toast } from "sonner";
import type { ViewNode } from "@/types/models";
import { viewIcon } from "@/components/view-icon";
import { EmojiPicker } from "@/components/emoji-picker";
import { NewPageMenu } from "./NewPageMenu";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { TagEditorDialog } from "@/components/tag-editor-dialog";
import { useWorkspaceStore } from "@/stores/workspace";
import { isDescendant, type DropZone } from "@/lib/tree";
import { exportPage } from "@/lib/export-page";
import { t } from "@/lib/i18n";

export interface DropHint {
  targetId: string;
  zone: DropZone;
}

interface PageTreeItemProps {
  node: ViewNode;
  depth: number;
  draggingId: string | null;
  dropHint: DropHint | null;
  onDraggingChange: (id: string | null) => void;
  onDropHint: React.Dispatch<React.SetStateAction<DropHint | null>>;
  onDrop: (viewId: string, targetId: string, zone: DropZone) => void;
}

const INDENT = 16; // 每级缩进（说明书 6.2：内容左边距 16px）

export function PageTreeItem({
  node,
  depth,
  draggingId,
  dropHint,
  onDraggingChange,
  onDropHint,
  onDrop,
}: PageTreeItemProps) {
  // 每树节点一份订阅：用原子 selector（含布尔派生），任一 store 字段变化只重渲受影响节点而非整棵树
  const tree = useWorkspaceStore((s) => s.tree);
  const isExpanded = useWorkspaceStore((s) => s.expanded.has(node.id));
  const isActive = useWorkspaceStore((s) => s.currentViewId === node.id);
  const openView = useWorkspaceStore((s) => s.openView);
  const toggleExpand = useWorkspaceStore((s) => s.toggleExpand);
  const renameView = useWorkspaceStore((s) => s.renameView);
  const setViewIcon = useWorkspaceStore((s) => s.setViewIcon);
  const setViewFavorite = useWorkspaceStore((s) => s.setViewFavorite);
  const deleteView = useWorkspaceStore((s) => s.deleteView);
  const expand = useWorkspaceStore((s) => s.expand);
  const hasChildren = node.children.length > 0;

  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(node.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [tagEditorOpen, setTagEditorOpen] = useState(false);
  const draggedRef = useRef(false);
  const isFavorite = node.is_favorite === 1;

  const zoneFor = (e: React.DragEvent): DropZone => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientY - rect.top) / rect.height;
    return ratio < 0.3 ? "before" : ratio > 0.7 ? "after" : "inside";
  };

  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData("application/x-view-id", node.id);
    e.dataTransfer.effectAllowed = "move";
    draggedRef.current = true;
    onDraggingChange(node.id);
  };

  const handleDragEnd = () => {
    draggedRef.current = false;
    onDraggingChange(null);
    onDropHint(null);
  };

  const handleDragOver = (e: React.DragEvent) => {
    if (!draggingId || draggingId === node.id) return;
    if (isDescendant(tree, node.id, draggingId)) return;
    e.preventDefault();
    e.stopPropagation();
    const zone = zoneFor(e);
    const hint: DropHint = { targetId: node.id, zone };
    onDropHint((prev) => (prev?.targetId === hint.targetId && prev.zone === hint.zone ? prev : hint));
  };

  const handleDrop = (e: React.DragEvent) => {
    if (!draggingId || draggingId === node.id) return;
    if (isDescendant(tree, node.id, draggingId)) return;
    e.preventDefault();
    e.stopPropagation();
    const zone = zoneFor(e);
    const from = draggingId;
    onDraggingChange(null);
    onDropHint(null);
    if (zone === "inside") expand(node.id);
    onDrop(from, node.id, zone);
  };

  const commitRename = async () => {
    const name = editName.trim();
    setEditing(false);
    if (!name || name === node.name) return;
    try {
      await renameView(node.id, name);
    } catch (e) {
      // DB 写失败（如 database is locked）：回退输入框 + toast 提示，避免静默丢名
      toast.error(t("error.renameView", { message: String(e) }));
    }
  };

  const hintFor = dropHint?.targetId === node.id ? dropHint.zone : null;

  return (
    <>
      <div
        draggable
        data-view-id={node.id}
        className={
          "group relative flex h-[30px] cursor-pointer items-center gap-1 pr-1 select-none " +
          (isActive ? "bg-brand-100 " : "hover:bg-neutral-300/40 ") +
          (hintFor === "inside" ? "bg-brand-100 ring-1 ring-brand-500" : "")
        }
        style={{ paddingLeft: 16 + depth * INDENT }}
        onClick={() => {
          if (draggedRef.current) return;
          openView(node.id);
        }}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {isActive && <div className="absolute left-0 top-0 h-full w-[3px] bg-brand-500" />}
        {hintFor === "before" && <div className="absolute -top-[1px] left-0 right-0 h-[2px] bg-brand-500" />}
        {hintFor === "after" && <div className="absolute -bottom-[1px] left-0 right-0 h-[2px] bg-brand-500" />}

        {hasChildren ? (
          <button
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-neutral-500 hover:bg-neutral-300"
            onClick={(e) => {
              e.stopPropagation();
              toggleExpand(node.id);
            }}
          >
            <ChevronRight className={"h-3.5 w-3.5 transition-transform " + (isExpanded ? "rotate-90" : "")} />
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}

        <span
          className="flex w-5 shrink-0 items-center justify-center text-neutral-500"
          onClick={(e) => e.stopPropagation()}
        >
          {/* 点击图标直接换图标（popover 选择器）；stopPropagation 防止触发行打开 */}
          <EmojiPicker
            value={node.icon}
            onChange={(icon) => void setViewIcon(node.id, icon)}
            triggerClassName="h-5 w-5 rounded text-[13px] text-neutral-500 hover:bg-neutral-300"
            trigger={viewIcon(node)}
          />
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-neutral-800">{node.name}</span>

        {/* 行尾操作按钮：hover 显示；菜单打开期间（trigger 带 data-state=open）保持可见，
            否则 Floating UI 重算时按钮隐藏（rect 0）会把菜单定位到左上角 */}
        <span className="hidden shrink-0 items-center group-hover:flex group-has-[[data-state=open]]:flex">
          <NewPageMenu parentId={node.id} align="end">
            <button
              data-testid="row-add"
              className="flex h-5 w-5 items-center justify-center rounded text-neutral-500 hover:bg-neutral-300"
              title={t("tree.addSubpage")}
              onClick={(e) => e.stopPropagation()}
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </NewPageMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                data-testid="row-menu"
                className="flex h-5 w-5 items-center justify-center rounded text-neutral-500 hover:bg-neutral-300"
                onClick={(e) => e.stopPropagation()}
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem
                onSelect={() => {
                  setEditName(node.name);
                  setEditing(true);
                }}
              >
                <Pencil className="mr-2 h-3.5 w-3.5" />
                {t("tree.rename")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void setViewFavorite(node.id, !isFavorite)}>
                <Star className={"mr-2 h-3.5 w-3.5 " + (isFavorite ? "fill-brand-500 text-brand-500" : "")} />
                {isFavorite ? t("tree.unfavorite") : t("tree.favorite")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setTagEditorOpen(true)}>
                <Tag className="mr-2 h-3.5 w-3.5" />
                {t("tree.editTags")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => exportPage(node.id, node.name, "markdown")}>
                <Download className="mr-2 h-3.5 w-3.5" />
                {t("tree.exportMd")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => exportPage(node.id, node.name, "html")}>
                <Download className="mr-2 h-3.5 w-3.5" />
                {t("tree.exportHtml")}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onSelect={() => setConfirmDelete(true)}
              >
                <Trash2 className="mr-2 h-3.5 w-3.5" />
                {t("tree.delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </div>

      {isExpanded &&
        node.children.map((child) => (
          <PageTreeItem
            key={child.id}
            node={child}
            depth={depth + 1}
            draggingId={draggingId}
            dropHint={dropHint}
            onDraggingChange={onDraggingChange}
            onDropHint={onDropHint}
            onDrop={onDrop}
          />
        ))}

      {editing && (
        <input
          autoFocus
          data-rename-input
          className="absolute left-0 z-10 h-[30px] w-full rounded bg-white px-2 text-[13px] outline-1 outline-brand-500"
          style={{ paddingLeft: 16 + depth * INDENT }}
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") setEditing(false);
          }}
          onClick={(e) => e.stopPropagation()}
        />
      )}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t("tree.confirmDeleteTitle")}
        description={t("tree.confirmDeleteDesc", { name: node.name })}
        onConfirm={() => deleteView(node.id)}
      />

      <TagEditorDialog view={node} open={tagEditorOpen} onOpenChange={setTagEditorOpen} />
    </>
  );
}
