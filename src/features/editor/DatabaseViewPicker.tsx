import { useEffect, useState } from "react";
import type { Editor } from "@tiptap/core";
import { Table2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useWorkspaceStore } from "@/stores/workspace";
import { flattenTree } from "@/lib/tree";
import { t } from "@/lib/i18n";

// 事件：slash 菜单"数据库表"触发本选择器
export const INSERT_DATABASE_VIEW_EVENT = "dsh:insert-database-view";

/** 选择要嵌入文档的数据库视图（同空间的 grid 视图） */
export function DatabaseViewPicker() {
  const tree = useWorkspaceStore((s) => s.tree);
  const [open, setOpen] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ editor: Editor }>).detail;
      if (detail?.editor) {
        setEditor(detail.editor);
        setOpen(true);
      }
    };
    window.addEventListener(INSERT_DATABASE_VIEW_EVENT, handler);
    return () => window.removeEventListener(INSERT_DATABASE_VIEW_EVENT, handler);
  }, []);

  const gridViews = flattenTree(tree).filter((v) => v.layout === "grid");

  const insert = (viewId: string, name: string) => {
    editor?.chain().focus().insertContent({ type: "databaseView", attrs: { viewId, name } }).run();
    setOpen(false);
    setEditor(null);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) setEditor(null); setOpen(o); }}>
      <DialogContent className="w-[420px]">
        <DialogHeader>
          <DialogTitle>{t("editor.insertDatabaseView")}</DialogTitle>
        </DialogHeader>
        <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
          {gridViews.length === 0 && <p className="py-6 text-center text-[13px] text-neutral-400">{t("editor.noTableView")}</p>}
          {gridViews.map((v) => (
            <button
              key={v.id}
              className="flex items-center gap-2 rounded-md px-2 py-2 text-left text-[13px] hover:bg-neutral-200/60"
              onClick={() => insert(v.id, v.name)}
            >
              <Table2 className="h-4 w-4 text-neutral-500" />
              <span className="min-w-0 flex-1 truncate">{v.name}</span>
            </button>
          ))}
        </div>
        {gridViews.length > 0 && (
          <div className="flex justify-end">
            <Button variant="outline" onClick={() => setOpen(false)}>
              {t("common.cancel")}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
