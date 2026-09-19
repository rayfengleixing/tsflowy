import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { Maximize2, X } from "lucide-react";
import { resolveAssetUrl } from "@/lib/assets";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

// 图片节点渲染（M3：显示 + 说明文字编辑 + 移除/放大按钮；caption 存 attr，节点为 atom）
//
// 说明输入用本地草稿 state：受控 value=node.attrs.caption + 每键 dispatch 时，
// 快速输入会拿到滞后的 node props 回写输入框，表现为"重复添加上之前输入的字符"。
// 草稿只在外部值变化（撤销/协同）时同步，自己的提交不回流重设。
//
// 放大：双击图片或点悬浮的放大按钮打开灯箱；灯箱内点击图片在适应屏幕/原始尺寸间切换，
// Esc 或点击背景关闭（portal 到 body，避免被编辑器滚动容器裁剪）。

export function ImageNodeView(props: ReactNodeViewProps<HTMLElement>) {
  const { node, updateAttributes, deleteNode, selected } = props;
  const [src, setSrc] = useState<string>("");
  const [zoomOpen, setZoomOpen] = useState(false);
  const imgWrapRef = useRef<HTMLDivElement>(null);

  const raw = (node.attrs.src as string | undefined) ?? "";
  const alt = (node.attrs.alt as string | undefined) ?? "";
  const attrCaption = (node.attrs as { caption?: string }).caption ?? "";
  const width = Math.max(20, Math.min(100, (node.attrs as { width?: number }).width ?? 100));

  useEffect(() => {
    let alive = true;
    if (raw.startsWith("assets/")) {
      resolveAssetUrl(raw)
        .then((url) => {
          if (alive) setSrc(url);
        })
        .catch((e: unknown) => {
          console.error("resolve asset failed", raw, e);
          if (alive) setSrc(raw);
        });
    } else {
      setSrc(raw);
    }
    return () => {
      alive = false;
    };
  }, [raw]);

  // caption 本地草稿（见文件头注释）：与 attr 不一致时才同步，避免自我回写
  const [caption, setCaption] = useState<string>(attrCaption);
  const captionRef = useRef(caption);
  useEffect(() => {
    if (attrCaption !== captionRef.current) {
      captionRef.current = attrCaption;
      setCaption(attrCaption);
    }
  }, [attrCaption]);

  const onCaptionChange = (value: string) => {
    captionRef.current = value;
    setCaption(value);
    updateAttributes({ caption: value });
  };

  // NodeView 内的原生事件会冒泡到 ProseMirror（其监听挂在编辑器根上，React 合成事件的
  // stopPropagation 拦不住），必须用原生监听在 input 自身截停 keydown/dragstart
  const captionInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = captionInputRef.current;
    if (!el) return;
    const stop = (e: Event) => e.stopPropagation();
    el.addEventListener("keydown", stop);
    el.addEventListener("dragstart", stop);
    return () => {
      el.removeEventListener("keydown", stop);
      el.removeEventListener("dragstart", stop);
    };
  }, []);

  // 宽度拖拽：以图片所在行宽为基准算百分比（clamp 20-100），mouseup 落一次 attr
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const wrap = imgWrapRef.current;
    if (!wrap) return;
    const base = wrap.getBoundingClientRect().width || 1;
    const startX = e.clientX;
    const onMove = (ev: MouseEvent) => {
      const pct = Math.max(20, Math.min(100, (((width / 100) * base + ev.clientX - startX) / base) * 100));
      if (wrap.firstElementChild instanceof HTMLElement) {
        wrap.firstElementChild.style.width = pct + "%";
      }
    };
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      const pct = Math.round(Math.max(20, Math.min(100, (((width / 100) * base + ev.clientX - startX) / base) * 100)));
      if (wrap.firstElementChild instanceof HTMLElement) {
        wrap.firstElementChild.style.width = ""; // 恢复由 React 控制
      }
      if (pct !== width) updateAttributes({ width: pct });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <NodeViewWrapper className="group/image relative my-3" data-drag-handle>
      <div className="rounded-lg">
        <div ref={imgWrapRef} className="relative w-full">
          <img
            src={src}
            alt={alt}
            data-asset-path={raw || undefined}
            style={width !== 100 ? { width: `${width}%` } : undefined}
            className={
              "block cursor-zoom-in rounded-lg border border-neutral-200 object-contain " +
              (width === 100 ? "max-h-[480px] w-full" : "max-h-[480px]")
            }
            onDoubleClick={(e) => {
              e.stopPropagation();
              setZoomOpen(true);
            }}
          />
          <div className="absolute right-2 top-2 hidden items-center gap-1 group-hover/image:flex">
            <button
              className="flex h-7 w-7 items-center justify-center rounded-md bg-neutral-900/70 text-white hover:bg-neutral-900"
              title={t("image.zoomIn")}
              onClick={() => setZoomOpen(true)}
            >
              <Maximize2 className="h-3.5 w-3.5" />
            </button>
            <button
              className="flex h-7 w-7 items-center justify-center rounded-md bg-neutral-900/70 text-white hover:bg-red-600"
              title={t("common.delete")}
              onClick={() => deleteNode()}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          {/* 选中态右下角宽度手柄：左右拖动调整显示宽度（20-100%），left 跟随图片实际宽度 */}
          {selected && (
            <div
              className="absolute bottom-0 h-4 w-4 cursor-ew-resize rounded-bl-md border-b-2 border-r-2 border-brand-500 bg-white/80"
              style={{ left: `calc(${width}% - 4px)` }}
              title={t("image.resizeHint")}
              onMouseDown={startResize}
              onDoubleClick={(e) => e.stopPropagation()}
              contentEditable={false}
            />
          )}
        </div>
        <input
          ref={captionInputRef}
          className="mt-1 w-full max-w-[70%] border-none bg-transparent text-center text-[12px] text-neutral-500 outline-none placeholder:text-neutral-400 focus:border-b focus:border-neutral-300"
          placeholder={t("image.captionPlaceholder")}
          value={caption}
          onChange={(e) => onCaptionChange(e.target.value)}
        />
      </div>
      {zoomOpen && <ImageLightbox src={src} alt={alt} onClose={() => setZoomOpen(false)} />}
    </NodeViewWrapper>
  );
}

function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const [zoomed, setZoomed] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-[100] bg-black/70" onClick={onClose}>
      <button
        className="absolute right-4 top-4 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/25"
        title={t("common.close")}
        onClick={onClose}
      >
        <X className="h-4 w-4" />
      </button>
      <div className="absolute inset-0 overflow-auto p-4">
        <div className="flex min-h-full min-w-full items-center justify-center">
          <img
            src={src}
            alt={alt}
            onClick={(e) => {
              e.stopPropagation();
              setZoomed((z) => !z);
            }}
            title={zoomed ? t("image.zoomOut") : t("image.zoomIn")}
            className={cn(
              "select-none rounded",
              zoomed ? "max-h-none max-w-none cursor-zoom-out" : "max-h-[92vh] max-w-[94vw] cursor-zoom-in",
            )}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
