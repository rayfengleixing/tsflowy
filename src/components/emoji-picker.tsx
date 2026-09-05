import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Eraser } from "lucide-react";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

const EMOJIS = [
  "📄",
  "📁",
  "⭐",
  "🔥",
  "✅",
  "📌",
  "💡",
  "📝",
  "🎯",
  "🚀",
  "📅",
  "📊",
  "🎨",
  "🧠",
  "💎",
  "🌱",
  "☕",
  "🎵",
  "🏷️",
  "🔖",
  "📚",
  "✏️",
  "🗂️",
  "🖼️",
  "🧩",
  "🎁",
  "🌍",
  "💬",
  "🔍",
  "⚙️",
];

export { EMOJIS };

interface EmojiPickerProps {
  value: string | null;
  onChange: (emoji: string | null) => void;
  triggerClassName?: string;
  /** 自定义触发内容（如视图图标）；缺省显示当前 emoji 或 🙂 */
  trigger?: ReactNode;
}

/** 简易 emoji 选择器（M2 够用；后续可换完整选择器） */
export function EmojiPicker({ value, onChange, triggerClassName, trigger }: EmojiPickerProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "flex h-6 w-6 items-center justify-center rounded text-base hover:bg-neutral-200",
            triggerClassName,
          )}
          title={t("tree.changeIcon")}
        >
          {trigger ?? value ?? "🙂"}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-2" align="start">
        <div className="grid grid-cols-6 gap-1">
          {EMOJIS.map((e) => (
            <button
              key={e}
              className="flex h-8 w-8 items-center justify-center rounded text-lg hover:bg-neutral-200"
              onClick={() => onChange(e)}
            >
              {e}
            </button>
          ))}
        </div>
        {value && (
          <Button
            variant="ghost"
            size="sm"
            className="mt-2 w-full justify-start text-neutral-600"
            onClick={() => onChange(null)}
          >
            <Eraser className="mr-1 h-3.5 w-3.5" />
            {t("tree.clearIcon")}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}
