import { useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from "react";
import { Extension } from "@tiptap/core";
import type { Editor, Range } from "@tiptap/core";
import Suggestion from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";
import { ReactRenderer } from "@tiptap/react";
import {
  AlignLeft,
  ArrowRight,
  CheckSquare,
  ChevronDown,
  Code2,
  File as FileIcon,
  FunctionSquare,
  Heading1,
  Heading2,
  Heading3,
  Image as ImageIcon,
  Images,
  Lightbulb,
  List,
  ListOrdered,
  ListTree,
  Minus,
  Quote,
  Smile,
  Table,
  Table2,
  Type,
  AtSign,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { t, type MessageKey } from "@/lib/i18n";
import { pinyinInitials } from "@/lib/pinyin-initials";
import { INSERT_DATABASE_VIEW_EVENT } from "./DatabaseViewPicker";
import { INSERT_EMOJI_EVENT } from "./EmojiPickerDialog";

const slashMenuKey = new PluginKey("slashMenu");

/** 附件上传：选文件 → save_asset 存 assets/ → 返回相对路径 */
async function uploadAttachment(): Promise<string | null> {
  try {
    const selected = await open({
      multiple: false,
    });
    if (typeof selected !== "string") return null;
    return await invoke<string>("save_asset", { sourcePath: selected });
  } catch (e) {
    console.error("upload attachment failed", e);
    toast.error(t("error.upload", { message: String(e) }));
    return null;
  }
}

export interface SlashItem {
  key: string;
  icon: ReactNode;
  /** 执行块命令（编辑器已聚焦；image 为异步上传） */
  run: (editor: Editor) => unknown;
}

/** 上下文过滤：表格内仅基础文本块（项目说明书 8.2 slash 菜单说明） */
function inTableOnly(key: string): boolean {
  return ["text", "paragraph", "bulletList", "orderedList", "taskList"].includes(key);
}

export const slashItems: SlashItem[] = [
  { key: "text", icon: <Type className="h-4 w-4" />, run: (e) => e.chain().focus().clearNodes().run() },
  {
    key: "heading1",
    icon: <Heading1 className="h-4 w-4" />,
    run: (e) => e.chain().focus().toggleHeading({ level: 1 }).run(),
  },
  {
    key: "heading2",
    icon: <Heading2 className="h-4 w-4" />,
    run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(),
  },
  {
    key: "heading3",
    icon: <Heading3 className="h-4 w-4" />,
    run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run(),
  },
  { key: "bulletList", icon: <List className="h-4 w-4" />, run: (e) => e.chain().focus().toggleBulletList().run() },
  {
    key: "orderedList",
    icon: <ListOrdered className="h-4 w-4" />,
    run: (e) => e.chain().focus().toggleOrderedList().run(),
  },
  { key: "taskList", icon: <CheckSquare className="h-4 w-4" />, run: (e) => e.chain().focus().toggleTaskList().run() },
  { key: "blockquote", icon: <Quote className="h-4 w-4" />, run: (e) => e.chain().focus().toggleBlockquote().run() },
  { key: "codeBlock", icon: <Code2 className="h-4 w-4" />, run: (e) => e.chain().focus().toggleCodeBlock().run() },
  { key: "hr", icon: <Minus className="h-4 w-4" />, run: (e) => e.chain().focus().setHorizontalRule().run() },
  {
    key: "image",
    icon: <ImageIcon className="h-4 w-4" />,
    run: async (e) => {
      try {
        const selected = await open({
          multiple: false,
          filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"] }],
        });
        if (typeof selected !== "string") return;
        const relative = await invoke<string>("save_asset", { sourcePath: selected });
        e.chain()
          .focus()
          .insertContent({ type: "image", attrs: { src: relative, alt: "" } })
          .run();
      } catch (err) {
        console.error("upload image failed", err);
        toast.error(t("error.upload", { message: String(err) }));
      }
    },
  },
  {
    key: "table",
    icon: <Table className="h-4 w-4" />,
    run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  {
    key: "databaseView",
    icon: <Table2 className="h-4 w-4" />,
    run: (e) => {
      // 把当前 editor + 插入位置（此时 selection 尚未被 slash 关闭改写）一并传给 handler
      window.dispatchEvent(
        new CustomEvent(INSERT_DATABASE_VIEW_EVENT, {
          detail: {
            editor: e,
            insertPos: e.state.selection.from,
          },
        }),
      );
    },
  },
  {
    key: "attachment",
    icon: <FileIcon className="h-4 w-4" />,
    run: async (e) => {
      const src = await uploadAttachment();
      if (!src) return;
      const name = src.split("/").pop() ?? "附件";
      e.chain().focus().insertContent({ type: "attachment", attrs: { src, name } }).run();
    },
  },
  { key: "paragraph", icon: <AlignLeft className="h-4 w-4" />, run: (e) => e.chain().focus().setParagraph().run() },
  // — M3 高级块入口（不在白名单里的自然禁止在 table 内使用）—
  {
    key: "math",
    icon: <FunctionSquare className="h-4 w-4" />,
    run: (e) =>
      e
        .chain()
        .focus()
        .insertContent({ type: "math", attrs: { tex: "" } })
        .run(),
  },
  {
    key: "callout",
    icon: <Lightbulb className="h-4 w-4" />,
    run: (e) =>
      e
        .chain()
        .focus()
        .insertContent({
          type: "callout",
          attrs: { emoji: "💡", color: "blue" },
          content: [{ type: "paragraph" }],
        })
        .run(),
  },
  {
    key: "toggle",
    icon: <ChevronDown className="h-4 w-4" />,
    run: (e) =>
      e
        .chain()
        .focus()
        .insertContent({
          type: "toggle",
          attrs: { collapsed: false },
          content: [{ type: "paragraph" }],
        })
        .run(),
  },
  {
    key: "outline",
    icon: <ListTree className="h-4 w-4" />,
    run: (e) => e.chain().focus().insertContent({ type: "outline" }).run(),
  },
  {
    key: "mention",
    icon: <AtSign className="h-4 w-4" />,
    run: (e) => e.chain().focus().insertContent({ type: "text", text: "@" }).run(),
  },
  {
    key: "emoji",
    icon: <Smile className="h-4 w-4" />,
    run: (e) => window.dispatchEvent(new CustomEvent(INSERT_EMOJI_EVENT, { detail: { editor: e } })),
  },
  {
    key: "imageGallery",
    icon: <Images className="h-4 w-4" />,
    run: (e) => e.chain().focus().insertContent({ type: "imageGallery" }).run(),
  },
];

/** 过滤 + 上下文限制（suggestion items 回调签名：({ query, editor })） */
export function filterSlashItems(props: { query: string; editor: Editor }): SlashItem[] {
  const { query, editor } = props;
  const q = query.toLowerCase();
  const inTable = editor.isActive("table");
  return slashItems.filter((item) => {
    const label = t(`slash.${item.key}` as MessageKey);
    const labelLower = label.toLowerCase();
    // 名称（中/英）、key、拼音首字母（如 "bt" → 标题）任一命中即显示
    const hit =
      labelLower.includes(q) || item.key.toLowerCase().includes(q) || pinyinInitials(label).toLowerCase().includes(q);
    if (!hit) return false;
    return !(inTable && !inTableOnly(item.key));
  });
}

interface SlashMenuListHandle {
  onKeyDown: (event: KeyboardEvent) => boolean;
}

function SlashMenuList(props: {
  items: SlashItem[];
  command: (item: SlashItem) => void;
  query: string;
  ref?: Ref<SlashMenuListHandle>;
}) {
  const { items, command, query, ref } = props;
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => setActive(0), [query, items]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent): boolean => {
      if (event.key === "ArrowDown") {
        setActive((a) => (a + 1) % Math.max(items.length, 1));
        return true;
      }
      if (event.key === "ArrowUp") {
        setActive((a) => (a - 1 + items.length) % Math.max(items.length, 1));
        return true;
      }
      if (event.key === "Enter" && items[active]) {
        command(items[active]);
        return true;
      }
      return false;
    },
    [items, active, command],
  );

  useImperativeHandle(ref, () => ({ onKeyDown }));

  useEffect(() => {
    listRef.current?.querySelector("[data-active='true']")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-[13px] text-neutral-500 shadow-lg">
        {t("slash.noMatch")}
      </div>
    );
  }

  return (
    <div
      ref={listRef}
      className="max-h-[320px] w-[240px] overflow-y-auto rounded-lg border border-neutral-300 bg-white py-1 shadow-lg"
    >
      {items.map((item, i) => (
        <button
          key={item.key}
          data-active={i === active}
          className={
            "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] " +
            (i === active ? "bg-brand-100 text-neutral-800" : "text-neutral-600")
          }
          onMouseEnter={() => setActive(i)}
          onClick={() => command(item)}
        >
          <span className="flex w-5 shrink-0 items-center justify-center text-neutral-500">{item.icon}</span>
          <span className="flex-1">{t(`slash.${item.key}` as MessageKey)}</span>
          <ArrowRight className="h-3 w-3 text-neutral-400" />
        </button>
      ))}
    </div>
  );
}

/**
 * Slash 菜单扩展（项目说明书 8.3）：输入 "/" 唤起（行首），实时过滤，Enter/↑/↓ 选择。
 * 基于 @tiptap/suggestion 的托管定位（props.mount）。
 */
export const SlashMenu = Extension.create({
  name: "slashMenu",

  addOptions() {
    return {
      char: "/",
      startOfLine: true,
      allowSpaces: true,
      pluginKey: slashMenuKey,
      items: filterSlashItems,
      command: ({ editor, range, props }: { editor: Editor; range: Range; props: SlashItem }) => {
        // 先删除 "/查询" 文本，再执行块命令
        editor.chain().focus().deleteRange(range).run();
        void props.run(editor);
      },
    };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    return [
      Suggestion({
        editor: this.editor,
        char: options.char,
        startOfLine: options.startOfLine,
        allowSpaces: options.allowSpaces,
        pluginKey: options.pluginKey,
        items: options.items,
        command: options.command,
        render: () => {
          let component: ReactRenderer<SlashMenuListHandle> | null = null;
          let unmount: (() => void) | null = null;
          return {
            onStart: (props) => {
              component = new ReactRenderer(SlashMenuList, { props, editor: props.editor });
              unmount = props.mount(component.element);
            },
            onUpdate: (props) => {
              component?.updateProps(props);
            },
            onExit: () => {
              unmount?.();
              component?.destroy();
              component = null;
              unmount = null;
            },
            onKeyDown: ({ event }) => {
              if (event.key === "Escape") return true;
              return component?.ref?.onKeyDown(event) ?? false;
            },
          };
        },
      }),
    ];
  },
});
