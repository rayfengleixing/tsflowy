import { useEffect, useState } from "react";
import type { Editor } from "@tiptap/core";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Eraser } from "lucide-react";
import { EMOJIS } from "@/components/emoji-picker";
import { t } from "@/lib/i18n";

// 事件：slash 菜单"插入表情" → 弹选择器 → 选完插入字符
export const INSERT_EMOJI_EVENT = "dsh:insert-emoji";

export function EmojiPickerDialog() {
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
    window.addEventListener(INSERT_EMOJI_EVENT, handler);
    return () => window.removeEventListener(INSERT_EMOJI_EVENT, handler);
  }, []);

  const insert = (emoji: string) => {
    editor?.chain().focus().insertContent(emoji).run();
    setOpen(false);
    setEditor(null);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) setEditor(null); setOpen(o); }}>
      <DialogContent className="w-[360px]">
        <DialogHeader>
          <DialogTitle>{t("emoji.pick")}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-7 gap-1">
          {EMOJIS.map((e) => (
            <button
              key={e}
              className="flex h-9 w-9 items-center justify-center rounded text-xl hover:bg-neutral-200"
              onClick={() => insert(e)}
            >
              {e}
            </button>
          ))}
        </div>
        <div className="mt-2 flex justify-end">
          <button
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-neutral-500 hover:bg-neutral-200"
            onClick={() => setOpen(false)}
          >
            <Eraser className="h-3.5 w-3.5" />
            {t("common.cancel")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
