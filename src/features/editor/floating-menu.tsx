import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import type { Selection } from "@tiptap/pm/state";
import {
  Bold,
  Italic,
  Underline,
  Strikethrough,
  Highlighter,
  Palette,
  Link2,
  Code,
  Eraser,
  Check,
  Unlink,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { clampFloatToEditor } from "./float-clamp";

// 选中文本浮动工具栏（项目说明书 8.3）。
// 说明：TipTap v3 @tiptap/react 未导出 React BubbleMenu 组件（独立拆包），此处手写跟随坐标版本：
// 监听 selectionUpdate 用 view.coordsAtPos(from/to) 拿到屏幕坐标 → CSS fixed 居中显示。
// 经验 1490687：所有交互按钮必须 onMouseDown 阻止默认，否则点击会让编辑器失焦而丢失选区。

const TEXT_COLORS = [
  { name: "default", value: "inherit", swatch: "border-neutral-300 bg-white text-neutral-700" },
  { name: "blue", value: "#0092D6", swatch: "bg-[#0092D6]" },
  { name: "red", value: "#D92D20", swatch: "bg-[#D92D20]" },
  { name: "green", value: "#12B76A", swatch: "bg-[#12B76A]" },
  { name: "orange", value: "#F79009", swatch: "bg-[#F79009]" },
  { name: "purple", value: "#9E77ED", swatch: "bg-[#9E77ED]" },
  { name: "gray", value: "#6F748C", swatch: "bg-[#6F748C]" },
] as const;

const HIGHLIGHT_COLORS = [
  { name: "none", value: "transparent", swatch: "border border-dashed border-neutral-300 bg-white" },
  { name: "yellow", value: "#FEF3C7", swatch: "bg-[#FEF3C7]" },
  { name: "blue", value: "#E3F6FF", swatch: "bg-[#E3F6FF]" },
  { name: "green", value: "#D1FAE5", swatch: "bg-[#D1FAE5]" },
  { name: "pink", value: "#FCE7F3", swatch: "bg-[#FCE7F3]" },
  { name: "purple", value: "#EDE9FE", swatch: "bg-[#EDE9FE]" },
] as const;

// 供块菜单（block-menu.tsx）复用
export { TEXT_COLORS, HIGHLIGHT_COLORS, SwatchPalette, IconBtn };

type SwatchPal = readonly { readonly name: string; readonly value: string; readonly swatch: string }[];

function IconBtn(props: {
  title: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={props.title}
      disabled={props.disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={props.onClick}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded text-neutral-600 hover:bg-neutral-200 disabled:opacity-40",
        props.active && "bg-brand-100 text-brand-600",
      )}
    >
      {props.children}
    </button>
  );
}

function Divider() {
  return <div className="mx-0.5 h-5 w-px bg-neutral-200" />;
}

function SwatchPalette<T extends SwatchPal>(props: {
  title: string;
  palette: T;
  current: string | null;
  onPick: (value: string) => void;
  onClose: () => void;
}) {
  const { palette, current, onPick, title } = props;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) props.onClose();
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [props]);
  return (
    <div
      ref={ref}
      className="absolute left-0 top-full z-50 mt-1 rounded-lg border border-neutral-300 bg-white p-2 shadow-lg"
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="mb-1 px-1 text-[11px] text-neutral-400">{title}</div>
      <div className="flex gap-1.5">
        {palette.map((c) => (
          <button
            key={c.name + c.value}
            type="button"
            title={c.name}
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded-full border border-neutral-200",
              c.swatch,
              current === c.value && "ring-2 ring-brand-500 ring-offset-1",
            )}
            onClick={() => onPick(c.value)}
          >
            {current === c.value && <Check className="h-3 w-3 text-white drop-shadow" />}
          </button>
        ))}
      </div>
    </div>
  );
}

function LinkPopover(props: { current: string | null; onSubmit: (url: string | null) => void; onClose: () => void }) {
  const [value, setValue] = useState(props.current ?? "");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) props.onClose();
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [props]);
  return (
    <div
      ref={ref}
      className="absolute left-0 top-full z-50 mt-1 flex items-center gap-1 rounded-lg border border-neutral-300 bg-white p-1 shadow-lg"
      onMouseDown={(e) => e.preventDefault()}
    >
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={t("float.linkPlaceholder")}
        className="h-7 w-56 rounded border-none bg-transparent px-2 text-[13px] outline-none placeholder:text-neutral-400"
        onKeyDown={(e) => {
          if (e.key === "Enter") props.onSubmit(value.trim() || null);
          if (e.key === "Escape") props.onClose();
        }}
      />
      {/* 语义：已有链接时 = 取消链接；无链接时 = 关闭（取消输入） */}
      <IconBtn
        title={props.current ? t("float.unlink") : t("common.cancel")}
        onClick={() => {
          if (props.current) props.onSubmit(null);
          else props.onClose();
        }}
      >
        {props.current ? <Unlink className="h-3.5 w-3.5" /> : <Eraser className="h-3.5 w-3.5" />}
      </IconBtn>
      <IconBtn title={t("common.confirm")} onClick={() => props.onSubmit(value.trim() || null)}>
        <Check className="h-3.5 w-3.5" />
      </IconBtn>
    </div>
  );
}

export function FloatingMenu(props: { editor: Editor | undefined }) {
  const { editor } = props;
  const boxRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [coord, setCoord] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [placed, setPlaced] = useState<{ x: number; y: number } | null>(null);
  const [colorOpen, setColorOpen] = useState(false);
  const [highlightOpen, setHighlightOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [, forceUpdate] = useState(0); // editor state 变化时刷新 active 态

  useEffect(() => {
    if (!editor) return;
    /** 判断是否是真正的"字符范围选择"（TextSelection 且 from!==to），排除 NodeSelection/AllSelection
     *  —— 防止打开页面/加载文档时因 ProseMirror 内部 NodeSelection 初始化事件触发工具栏默认显示（需求2彻底修复）
     */
    const isCharSelection = (sel: Selection): boolean => {
      if (!sel || sel.empty) return false;
      const name = sel.constructor?.name as string | undefined;
      if (name) {
        if (name !== "TextSelection") return false; // NodeSelection/AllSelection/GapSelection etc 一律不显示
      } else {
        // Fallback：没有 constructor name 就通过"起点/终点都在 inline 文本块中"判断
        try {
          const { $from, $to } = sel;
          if (!$from.parent.isTextblock || !$to.parent.isTextblock) return false;
        } catch {
          return false;
        }
      }
      if (typeof sel.from !== "number" || typeof sel.to !== "number") return false;
      if (sel.from >= sel.to) return false;
      return true;
    };

    const update = () => {
      forceUpdate((x) => x + 1);
      const sel = editor.state.selection;
      // 需求2（严格门）：必须是字符范围选择
      if (!isCharSelection(sel)) {
        setVisible(false);
        return;
      }
      // 跳过图片/代码块/表格/数据库/其他 atom 容器节点
      const forbidden = [
        "image",
        "codeBlock",
        "table",
        "math",
        "databaseView",
        "attachment",
        "callout",
        "toggle",
        "columns",
        "imageGallery",
        "outline",
      ];
      for (const name of forbidden) {
        if (editor.isActive(name)) {
          setVisible(false);
          return;
        }
      }
      // ProseMirror view 给出选区边界屏幕坐标
      try {
        const from = editor.view.coordsAtPos(sel.from);
        const to = editor.view.coordsAtPos(sel.to);
        const x = (from.left + to.right) / 2;
        const y = from.top - 8; // 顶部上方 8px
        setCoord({ x, y });
        setVisible(true);
      } catch (e) {
        setVisible(false);
      }
    };
    editor.on("selectionUpdate", update);
    editor.on("update", update);
    editor.on("blur", () => {
      // 延迟：点击自己工具栏前 blur 会触发；用 rAF 让 onMouseDown 的 preventDefault 阻止 blur 之后再隐藏
      requestAnimationFrame(() => {
        if (!document.activeElement || (boxRef.current && boxRef.current.contains(document.activeElement))) return;
        if (boxRef.current && boxRef.current.matches(":hover")) return;
        setVisible(false);
      });
    });
    update();
    return () => {
      editor.off("selectionUpdate", update);
      editor.off("update", update);
    };
  }, [editor]);

  // 滚动时关闭（避免坐标错位）
  useEffect(() => {
    if (!visible) return;
    const onScroll = () => setVisible(false);
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  }, [visible]);

  // 渲染后量测实际尺寸，把 fixed 浮层 clamp 进编辑区可视矩形（窄面板不飘出编辑区）
  useLayoutEffect(() => {
    if (!visible || !boxRef.current || !editor) return;
    const w = boxRef.current.offsetWidth;
    const h = boxRef.current.offsetHeight;
    if (!w || !h) return;
    // 原定位：translate(-50%,-100%)，即盒子左下角落在 (coord.x, coord.y)
    const rawLeft = coord.x - w / 2;
    const rawTop = coord.y - h;
    setPlaced(clampFloatToEditor(editor, rawLeft, rawTop, w, h));
  }, [visible, coord, editor]);

  // 需求2：渲染级再兜一层 —— 只有 TextSelection（字符范围）选中才渲染
  const selection = editor?.state.selection;
  const isCharSelection =
    !!selection &&
    !selection.empty &&
    typeof selection.from === "number" &&
    typeof selection.to === "number" &&
    selection.from < selection.to &&
    selection.constructor?.name === "TextSelection";
  if (!editor || !visible || !isCharSelection) return null;

  const closeAll = () => {
    setColorOpen(false);
    setHighlightOpen(false);
    setLinkOpen(false);
  };

  const currentTextColor = (() => {
    const s = editor.getAttributes("textStyle");
    return typeof s.color === "string" ? s.color : null;
  })();
  const currentHighlight = (() => {
    const s = editor.getAttributes("highlight");
    return typeof s.color === "string" ? s.color : "transparent";
  })();
  const currentLink = (() => {
    const s = editor.getAttributes("link");
    return typeof s.href === "string" ? s.href : null;
  })();

  // Box 尺寸由内容决定；定位：fixed 居中（render 后 layout 量测 → clamp 到编辑区内）
  return (
    <div
      ref={boxRef}
      style={{
        position: "fixed",
        left: `${placed?.x ?? coord.x}px`,
        top: `${placed?.y ?? coord.y - 40}px`,
        zIndex: 50,
      }}
      onMouseDown={(e) => e.preventDefault()}
      onMouseLeave={() => {
        /* noop */
      }}
    >
      <div className="relative flex items-center rounded-lg border border-neutral-200 bg-white px-1 py-1 shadow-lg">
        <IconBtn
          title={t("float.bold")}
          active={editor.isActive("bold")}
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          <Bold className="h-4 w-4" />
        </IconBtn>
        <IconBtn
          title={t("float.italic")}
          active={editor.isActive("italic")}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          <Italic className="h-4 w-4" />
        </IconBtn>
        <IconBtn
          title={t("float.underline")}
          active={editor.isActive("underline")}
          onClick={() => editor.chain().focus().toggleUnderline().run()}
        >
          <Underline className="h-4 w-4" />
        </IconBtn>
        <IconBtn
          title={t("float.strike")}
          active={editor.isActive("strike")}
          onClick={() => editor.chain().focus().toggleStrike().run()}
        >
          <Strikethrough className="h-4 w-4" />
        </IconBtn>
        <Divider />
        <div className="relative">
          <IconBtn
            title={t("float.highlight")}
            active={currentHighlight !== "transparent"}
            onClick={() => {
              setHighlightOpen((v) => !v);
              setColorOpen(false);
              setLinkOpen(false);
            }}
          >
            <Highlighter className="h-4 w-4" />
          </IconBtn>
          {highlightOpen && (
            <SwatchPalette
              title={t("float.highlight")}
              palette={HIGHLIGHT_COLORS}
              current={currentHighlight}
              onPick={(v) => {
                if (v === "transparent") editor.chain().focus().unsetHighlight().run();
                else editor.chain().focus().setHighlight({ color: v }).run();
                setHighlightOpen(false);
              }}
              onClose={() => setHighlightOpen(false)}
            />
          )}
        </div>
        <div className="relative">
          <IconBtn
            title={t("float.color")}
            active={!!currentTextColor}
            onClick={() => {
              setColorOpen((v) => !v);
              setHighlightOpen(false);
              setLinkOpen(false);
            }}
          >
            <Palette className="h-4 w-4" />
          </IconBtn>
          {colorOpen && (
            <SwatchPalette
              title={t("float.color")}
              palette={TEXT_COLORS}
              current={currentTextColor}
              onPick={(v) => {
                if (v === "inherit") editor.chain().focus().unsetColor().run();
                else editor.chain().focus().setColor(v).run();
                setColorOpen(false);
              }}
              onClose={() => setColorOpen(false)}
            />
          )}
        </div>
        <div className="relative">
          <IconBtn
            title={t("float.link")}
            active={!!currentLink}
            onClick={() => {
              closeAll();
              setLinkOpen(!linkOpen);
            }}
          >
            <Link2 className="h-4 w-4" />
          </IconBtn>
          {linkOpen && (
            <LinkPopover
              current={currentLink}
              onSubmit={(url) => {
                if (!url) editor.chain().focus().unsetLink().run();
                else editor.chain().focus().setLink({ href: url, target: "_blank", rel: "noopener noreferrer" }).run();
                setLinkOpen(false);
              }}
              onClose={() => setLinkOpen(false)}
            />
          )}
        </div>
        {!!currentLink && (
          <IconBtn title={t("float.unlink")} onClick={() => editor.chain().focus().unsetLink().run()}>
            <Unlink className="h-4 w-4" />
          </IconBtn>
        )}
        <Divider />
        <IconBtn
          title={t("float.code")}
          active={editor.isActive("code")}
          onClick={() => editor.chain().focus().toggleCode().run()}
        >
          <Code className="h-4 w-4" />
        </IconBtn>
        <Divider />
        <IconBtn
          title={t("float.clearFormat")}
          onClick={() => editor.chain().focus().clearNodes().unsetAllMarks().run()}
        >
          <Eraser className="h-4 w-4" />
        </IconBtn>
      </div>
    </div>
  );
}
