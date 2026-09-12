// 块菜单（点击块拖拽手柄弹出）：对齐 / 转换块类型 / 剪切复制删除 / 文字颜色 / 背景色。
// 由 block-drag 扩展在"点击手柄（未拖拽）"时派发 BLOCK_MENU_EVENT 打开，fixed 定位在块旁。
import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import { toast } from "sonner";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  CheckSquare,
  Code2,
  Copy,
  Heading1,
  Heading2,
  Heading3,
  Highlighter,
  List,
  ListOrdered,
  Palette,
  Quote,
  Scissors,
  Trash2,
  Type,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { t, type MessageKey } from "@/lib/i18n";
import { TEXT_COLORS, HIGHLIGHT_COLORS, SwatchPalette, IconBtn } from "./floating-menu";
import { clampXToEditor } from "./float-clamp";

export const BLOCK_MENU_EVENT = "tsflowy:block-menu";

export interface BlockMenuPayload {
  /** 块在 doc 中的起始 pos */
  pos: number;
  nodeType: string;
  nodeSize: number;
  /** 块左边缘屏幕坐标 */
  x: number;
  /** 块顶部屏幕坐标 */
  y: number;
  editor: Editor;
}

/** 容器块（列表/引用/表格等）：转换类型只提供"转为文本"（解包），避免破坏嵌套结构 */
const CONTAINER_TYPES = new Set([
  "bulletList",
  "orderedList",
  "taskList",
  "blockquote",
  "columns",
  "toggle",
  "table",
  "callout",
  "math",
  "outline",
  "databaseView",
  "database_view",
  "attachment",
  "image",
  "imageGallery",
  "image-gallery",
]);

const MENU_WIDTH = 284;

interface ConvertItem {
  key: string;
  icon: React.ReactNode;
  run: (editor: Editor, pos: number) => boolean;
}

const CONVERT_ITEMS: ConvertItem[] = [
  {
    key: "text",
    icon: <Type className="h-4 w-4" />,
    run: (e, p) =>
      e
        .chain()
        .focus()
        .setTextSelection(p + 1)
        .setParagraph()
        .run(),
  },
  {
    key: "heading1",
    icon: <Heading1 className="h-4 w-4" />,
    run: (e, p) =>
      e
        .chain()
        .focus()
        .setTextSelection(p + 1)
        .toggleHeading({ level: 1 })
        .run(),
  },
  {
    key: "heading2",
    icon: <Heading2 className="h-4 w-4" />,
    run: (e, p) =>
      e
        .chain()
        .focus()
        .setTextSelection(p + 1)
        .toggleHeading({ level: 2 })
        .run(),
  },
  {
    key: "heading3",
    icon: <Heading3 className="h-4 w-4" />,
    run: (e, p) =>
      e
        .chain()
        .focus()
        .setTextSelection(p + 1)
        .toggleHeading({ level: 3 })
        .run(),
  },
  {
    key: "blockquote",
    icon: <Quote className="h-4 w-4" />,
    run: (e, p) =>
      e
        .chain()
        .focus()
        .setTextSelection(p + 1)
        .toggleBlockquote()
        .run(),
  },
  {
    key: "codeBlock",
    icon: <Code2 className="h-4 w-4" />,
    run: (e, p) =>
      e
        .chain()
        .focus()
        .setTextSelection(p + 1)
        .toggleCodeBlock()
        .run(),
  },
  {
    key: "bulletList",
    icon: <List className="h-4 w-4" />,
    run: (e, p) =>
      e
        .chain()
        .focus()
        .setTextSelection(p + 1)
        .toggleBulletList()
        .run(),
  },
  {
    key: "orderedList",
    icon: <ListOrdered className="h-4 w-4" />,
    run: (e, p) =>
      e
        .chain()
        .focus()
        .setTextSelection(p + 1)
        .toggleOrderedList()
        .run(),
  },
  {
    key: "taskList",
    icon: <CheckSquare className="h-4 w-4" />,
    run: (e, p) =>
      e
        .chain()
        .focus()
        .setTextSelection(p + 1)
        .toggleTaskList()
        .run(),
  },
];

/** 全选整块文本（颜色/对齐/复制用） */
function selectWholeText(editor: Editor, pos: number, nodeSize: number) {
  return editor
    .chain()
    .focus()
    .setTextSelection({ from: pos + 1, to: pos + nodeSize - 1 });
}

export function BlockMenu() {
  const [payload, setPayload] = useState<BlockMenuPayload | null>(null);
  const [colorOpen, setColorOpen] = useState(false);
  const [highlightOpen, setHighlightOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  const close = () => {
    setPayload(null);
    setColorOpen(false);
    setHighlightOpen(false);
  };

  useEffect(() => {
    const onOpen = (e: Event) => {
      setPayload((e as CustomEvent<BlockMenuPayload>).detail);
      setColorOpen(false);
      setHighlightOpen(false);
    };
    const onMouseDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onScroll = () => close();
    window.addEventListener(BLOCK_MENU_EVENT, onOpen);
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener(BLOCK_MENU_EVENT, onOpen);
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, []);

  if (!payload) return null;
  const { pos, nodeType, nodeSize, x, y, editor } = payload;
  const isContainer = CONTAINER_TYPES.has(nodeType);
  // 定位：优先块左侧；左侧空间不足则放右侧；再用编辑区边界 clamp（行详情窄面板不飘出）
  let left = x - MENU_WIDTH - 12 < 8 ? x + 12 : x - MENU_WIDTH - 12;
  const top = Math.max(8, y - 24);
  left = clampXToEditor(editor, left, MENU_WIDTH);

  const currentTextColor = (() => {
    const s = editor.getAttributes("textStyle");
    return typeof s.color === "string" ? s.color : null;
  })();
  const currentHighlight = (() => {
    const s = editor.getAttributes("highlight");
    return typeof s.color === "string" ? s.color : "transparent";
  })();

  const runConvert = (item: ConvertItem) => {
    try {
      if (isContainer) return;
      item.run(editor, pos);
    } finally {
      close();
    }
  };

  const runToText = () => {
    try {
      const node = editor.state.doc.nodeAt(pos);
      if (!node) return;
      // 提取容器内所有文本块文本，重建为若干段落（clearNodes 解包会产生多余空段落，故手动重建）
      const texts: string[] = [];
      node.descendants((child) => {
        if (child.isTextblock) {
          texts.push(child.textContent);
          return false;
        }
        return true;
      });
      const blocks = texts.map((text) =>
        text ? { type: "paragraph", content: [{ type: "text", text }] } : { type: "paragraph" },
      );
      if (blocks.length === 0) blocks.push({ type: "paragraph" });
      editor
        .chain()
        .focus()
        .deleteRange({ from: pos, to: pos + node.nodeSize })
        .insertContentAt(pos, blocks)
        .run();
    } finally {
      close();
    }
  };

  const runAlign = (align: "left" | "center" | "right") => {
    try {
      selectWholeText(editor, pos, nodeSize).setTextAlign(align).run();
    } finally {
      close();
    }
  };

  const runCopy = async () => {
    try {
      const text = editor.state.doc.textBetween(pos + 1, pos + nodeSize - 1, "\n");
      await navigator.clipboard.writeText(text);
      toast.success(t("blockMenu.copied"));
    } catch (e) {
      console.error("copy block failed", e);
    } finally {
      close();
    }
  };

  const runCut = async () => {
    try {
      const text = editor.state.doc.textBetween(pos + 1, pos + nodeSize - 1, "\n");
      selectWholeText(editor, pos, nodeSize).run();
      await navigator.clipboard.writeText(text);
      editor
        .chain()
        .focus()
        .deleteRange({ from: pos, to: pos + nodeSize })
        .run();
    } finally {
      close();
    }
  };

  const runDelete = () => {
    try {
      editor
        .chain()
        .focus()
        .deleteRange({ from: pos, to: pos + nodeSize })
        .run();
    } finally {
      close();
    }
  };

  const pickColor = (v: string) => {
    try {
      const chain = selectWholeText(editor, pos, nodeSize);
      if (v === "inherit") chain.unsetColor().run();
      else chain.setColor(v).run();
    } finally {
      setColorOpen(false);
    }
  };

  const pickHighlight = (v: string) => {
    try {
      const chain = selectWholeText(editor, pos, nodeSize);
      if (v === "transparent") chain.unsetHighlight().run();
      else chain.setHighlight({ color: v }).run();
    } finally {
      setHighlightOpen(false);
    }
  };

  return (
    <div
      ref={boxRef}
      className="fixed z-[60] w-[284px] rounded-lg border border-neutral-200 bg-white py-1.5 shadow-2xl dark:border-neutral-700 dark:bg-neutral-900"
      style={{ left, top }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {/* 对齐 */}
      <div className="flex items-center gap-1 border-b border-neutral-100 px-2 pb-1.5 dark:border-neutral-800">
        <span className="mr-1 w-8 shrink-0 text-[11px] text-neutral-400">{t("blockMenu.align")}</span>
        <IconBtn title={t("blockMenu.alignLeft")} onClick={() => runAlign("left")}>
          <AlignLeft className="h-4 w-4" />
        </IconBtn>
        <IconBtn title={t("blockMenu.alignCenter")} onClick={() => runAlign("center")}>
          <AlignCenter className="h-4 w-4" />
        </IconBtn>
        <IconBtn title={t("blockMenu.alignRight")} onClick={() => runAlign("right")}>
          <AlignRight className="h-4 w-4" />
        </IconBtn>
      </div>

      {/* 转换块类型 */}
      {isContainer ? (
        <div className="border-b border-neutral-100 px-2 py-1.5 dark:border-neutral-800">
          <div className="mb-1 px-1 text-[11px] text-neutral-400">{t("blockMenu.convert")}</div>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-neutral-600 hover:bg-neutral-100 dark:hover:bg-neutral-800"
            onClick={runToText}
          >
            <Type className="h-4 w-4 text-neutral-500" />
            {t("blockMenu.toText")}
          </button>
        </div>
      ) : (
        <div className="border-b border-neutral-100 px-2 py-1.5 dark:border-neutral-800">
          <div className="mb-1 px-1 text-[11px] text-neutral-400">{t("blockMenu.convert")}</div>
          <div className="grid grid-cols-3 gap-1">
            {CONVERT_ITEMS.map((item) => (
              <button
                key={item.key}
                type="button"
                title={t(`blockMenu.${item.key}` as MessageKey)}
                className={cn(
                  "flex flex-col items-center gap-0.5 rounded px-1 py-1.5 text-[11px] text-neutral-600 hover:bg-neutral-100 dark:hover:bg-neutral-800",
                )}
                onClick={() => runConvert(item)}
              >
                <span className="text-neutral-500">{item.icon}</span>
                {t(`blockMenu.${item.key}` as MessageKey)}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 剪切/复制/删除 */}
      <div className="flex items-center gap-1 border-b border-neutral-100 px-2 py-1.5 dark:border-neutral-800">
        <IconBtn title={t("blockMenu.copy")} onClick={() => void runCopy()}>
          <Copy className="h-4 w-4" />
        </IconBtn>
        <IconBtn title={t("blockMenu.cut")} onClick={() => void runCut()}>
          <Scissors className="h-4 w-4" />
        </IconBtn>
        <IconBtn title={t("blockMenu.delete")} onClick={runDelete}>
          <Trash2 className="h-4 w-4" />
        </IconBtn>
      </div>

      {/* 文字颜色 / 背景色 */}
      <div className="flex items-center gap-1 px-2 pt-1.5">
        <div className="relative">
          <IconBtn
            title={t("blockMenu.color")}
            active={!!currentTextColor}
            onClick={() => {
              setColorOpen((v) => !v);
              setHighlightOpen(false);
            }}
          >
            <Palette className="h-4 w-4" />
          </IconBtn>
          {colorOpen && (
            <SwatchPalette
              title={t("blockMenu.color")}
              palette={TEXT_COLORS}
              current={currentTextColor}
              editor={editor}
              onPick={pickColor}
              onClose={() => setColorOpen(false)}
            />
          )}
        </div>
        <div className="relative">
          <IconBtn
            title={t("blockMenu.highlight")}
            active={currentHighlight !== "transparent"}
            onClick={() => {
              setHighlightOpen((v) => !v);
              setColorOpen(false);
            }}
          >
            <Highlighter className="h-4 w-4" />
          </IconBtn>
          {highlightOpen && (
            <SwatchPalette
              title={t("blockMenu.highlight")}
              palette={HIGHLIGHT_COLORS}
              current={currentHighlight}
              editor={editor}
              onPick={pickHighlight}
              onClose={() => setHighlightOpen(false)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

export default BlockMenu;
