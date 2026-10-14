import { useEffect, useState } from "react";
import type { Editor } from "@tiptap/core";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useWorkspaceStore } from "@/stores/workspace";
import { embeddableDatabaseViews } from "@/lib/database-view";
import { layoutMeta, viewIcon } from "@/components/view-icon";
import { t } from "@/lib/i18n";

// 事件：slash 菜单"数据库表"触发本选择器（detail 携带 editor + slash 触发时的插入位置）
export const INSERT_DATABASE_VIEW_EVENT = "dsh:insert-database-view";

/** 选择要嵌入文档的数据库视图（同空间的全部数据库布局视图，与 node view 的只读表格渲染无关） */
export function DatabaseViewPicker() {
  const tree = useWorkspaceStore((s) => s.tree);
  const [open, setOpen] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [insertPos, setInsertPos] = useState<number | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ editor?: Editor; insertPos?: number } | undefined>).detail;
      if (detail?.editor) {
        setEditor(detail.editor);
        setInsertPos(typeof detail.insertPos === "number" ? detail.insertPos : null);
        setOpen(true);
      }
    };
    window.addEventListener(INSERT_DATABASE_VIEW_EVENT, handler);
    return () => window.removeEventListener(INSERT_DATABASE_VIEW_EVENT, handler);
  }, []);

  const dbViews = embeddableDatabaseViews(tree);

  const close = () => {
    setOpen(false);
    setEditor(null);
    setInsertPos(null);
  };

  const insert = (viewId: string, name: string) => {
    if (editor) {
      const content = { type: "databaseView", attrs: { viewId, name } };
      const chain = editor.chain().focus();
      // slash 触发时记录的位置优先：对话框期间选区可能已被其它操作挪走，落回当前选区
      if (insertPos != null) chain.insertContentAt(insertPos, content);
      else chain.insertContent(content);
      chain.run();
    }
    close();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
      <DialogContent className="w-[420px]">
        <DialogHeader>
          <DialogTitle>{t("editor.insertDatabaseView")}</DialogTitle>
        </DialogHeader>
        <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
          {dbViews.length === 0 && (
            <p className="py-6 text-center text-[13px] text-neutral-400">{t("editor.noTableView")}</p>
          )}
          {dbViews.map((v) => (
            <button
              key={v.id}
              className="flex items-center gap-2 rounded-md px-2 py-2 text-left text-[13px] hover:bg-neutral-200/60"
              onClick={() => insert(v.id, v.name)}
            >
              <span className="flex h-4 w-4 shrink-0 items-center justify-center">{viewIcon(v)}</span>
              <span className="min-w-0 flex-1 truncate">{v.name}</span>
              <span className="shrink-0 text-[11px] text-neutral-400">{layoutMeta(v.layout).label}</span>
            </button>
          ))}
        </div>
        {dbViews.length > 0 && (
          <div className="flex justify-end">
            <Button variant="outline" onClick={close}>
              {t("common.cancel")}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
