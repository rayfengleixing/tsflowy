import { useEffect, useState } from "react";
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { X } from "lucide-react";
import { resolveAssetUrl } from "@/lib/assets";

// 图片节点渲染（M3：显示 + 说明文字编辑 + 移除按钮；caption 存 attr，节点为 atom）
export function ImageNodeView(props: ReactNodeViewProps<HTMLElement>) {
  const { node, updateAttributes, deleteNode, selected } = props;
  const [src, setSrc] = useState<string>("");

  useEffect(() => {
    let alive = true;
    const raw = (node.attrs.src as string | undefined) ?? "";
    if (raw.startsWith("assets/")) {
      resolveAssetUrl(raw)
        .then((url) => {
          if (alive) setSrc(url);
        })
        .catch((e) => {
          console.error("resolve asset failed", raw, e);
          if (alive) setSrc(raw);
        });
    } else {
      setSrc(raw);
    }
    return () => {
      alive = false;
    };
  }, [node.attrs.src]);

  return (
    <NodeViewWrapper className="group/image relative my-3" data-drag-handle>
      <div className={"rounded-lg " + (selected ? "ring-2 ring-brand-500" : "")}>
        <div className="relative">
          <img
            src={src}
            alt={(node.attrs.alt as string) ?? ""}
            className="max-h-[480px] w-full rounded-lg border border-neutral-200 object-contain"
          />
          <button
            className="absolute right-2 top-2 hidden h-7 w-7 items-center justify-center rounded-md bg-neutral-900/70 text-white hover:bg-neutral-900 group-hover/image:flex"
            title="删除图片"
            onClick={() => deleteNode()}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <input
          className="mt-1 w-full max-w-[70%] border-none bg-transparent text-center text-[12px] text-neutral-500 outline-none placeholder:text-neutral-400 focus:border-b focus:border-neutral-300"
          placeholder="添加说明…"
          value={(node.attrs.caption as string) ?? ""}
          onChange={(e) => updateAttributes({ caption: e.target.value })}
        />
      </div>
    </NodeViewWrapper>
  );
}