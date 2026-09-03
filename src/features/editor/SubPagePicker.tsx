import { useEffect, useState } from "react";
import type { Editor } from "@tiptap/core";
import { Link2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useWorkspaceStore } from "@/stores/workspace";
import { flattenTree } from "@/lib/tree";
import { viewIcon } from "@/components/view-icon";
import { t } from "@/lib/i18n";
import type { View } from "@/types/models";

// 事件：slash 菜单"子页面" → 弹选择器 → 选完插入 subPage node
export const INSERT_SUB_PAGE_EVENT = "dsh:insert-sub-page";

/** 选择要嵌入的子页面（当前工作区所有非 row_detail 视图） */
export function SubPagePicker() {
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
    window.addEventListener(INSERT_SUB_PAGE_EVENT, handler);
    return () => window.removeEventListener(INSERT_SUB_PAGE_EVENT, handler);
  }, []);

  const views: View[] = flattenTree(tree).filter((v) => {
    try {
      const extra = JSON.parse(v.extra ?? "{}");
      return !extra.row_detail;
    } catch {
      return true;
    }
  });

  const insert = (viewId: string) => {
    editor?.chain().focus().insertContent({ type: "subPage", attrs: { viewId } }).run();
    setOpen(false);
    setEditor(null);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) setEditor(null); setOpen(o); }}>
      <DialogContent className="w-[460px]">
        <DialogHeader>
          <DialogTitle>{t("subPage.placeholder")}</DialogTitle>
        </DialogHeader>
        <div className="flex max-h-80 flex-col gap-1 overflow-y-auto">
          {views.length === 0 && <p className="py-6 text-center text-[13px] text-neutral-400">{t("subPage.noView")}</p>}
          {views.map((v) => (
            <button
              key={v.id}
              className="flex items-center gap-2 rounded-md px-2 py-2 text-left text-[13px] hover:bg-neutral-200/60"
              onClick={() => insert(v.id)}
            >
              <span className="text-base leading-none">{viewIcon(v)}</span>
              <Link2 className="h-3.5 w-3.5 text-neutral-400" />
              <span className="min-w-0 flex-1 truncate">{v.name}</span>
            </button>
          ))}
        </div>
        {views.length > 0 && (
          <div className="flex justify-end">
            <Button variant="outline" onClick={() => setOpen(false)}>{t("common.cancel")}</Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
