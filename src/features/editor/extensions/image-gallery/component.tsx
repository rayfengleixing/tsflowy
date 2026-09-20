import { useRef } from "react";
import { NodeViewContent, NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { Upload, X, ImagePlus } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";

export function ImageGalleryNodeView(props: ReactNodeViewProps<HTMLElement>) {
  const { node, editor, deleteNode, getPos } = props;
  const inputRef = useRef<HTMLInputElement>(null);
  const empty = node.childCount === 0;

  const openMulti = async () => {
    try {
      const selecteds = await open({
        multiple: true,
        filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"] }],
      });
      if (!Array.isArray(selecteds) || selecteds.length === 0) return;
      const posVal = typeof getPos === "function" ? getPos() : undefined;
      // 多文件并行上传
      const uploads = await Promise.all(
        selecteds.map(async (s) => {
          try {
            return await invoke<string>("save_asset", { sourcePath: s });
          } catch (e) {
            logger.error("gallery upload single failed", e);
            return null;
          }
        }),
      );
      const rels = uploads.filter((x): x is string => Boolean(x));
      if (rels.length === 0) return;
      if (typeof posVal !== "number" || posVal <= 0) {
        // 兜底：通过命令在选区末尾依次插入（会跑到 gallery 外，但不至于彻底失败）
        for (const r of rels) {
          editor
            .chain()
            .focus()
            .insertContent({ type: "image", attrs: { src: r, alt: "" } })
            .run();
        }
        return;
      }
      const galleryNode = editor.state.doc.nodeAt(posVal);
      if (!galleryNode) return;
      const galleryEnd = posVal + galleryNode.nodeSize - 1;
      const newImgNodes = rels.map((r) => editor.schema.node("image", { src: r, alt: "", caption: "" }));
      const tr = editor.state.tr.insert(galleryEnd, newImgNodes);
      // 不 scrollIntoView：selection 常停留在文档其他位置（如末尾），插入图片后会把页面滚走
      editor.view.dispatch(tr);
    } catch (e) {
      logger.error("gallery upload failed", e);
      toast.error(t("error.upload", { message: String(e) }));
    }
  };

  return (
    <NodeViewWrapper
      data-drag-handle
      className="group/gallery relative my-3 rounded-lg border border-neutral-200 bg-white p-2"
    >
      {/* 顶部工具栏：批量上传按钮 + 删除 */}
      <div className="mb-2 flex items-center justify-between pr-0.5 pl-1">
        <div className="flex items-center gap-1 text-[12px] text-neutral-500">
          <ImagePlus className="h-3.5 w-3.5" />
          <span>
            {t("slash.imageGallery")}
            {empty ? " · " + t("imageGallery.empty").split("，")[0] : ` · ${node.childCount} 张`}
          </span>
        </div>
        <div className="flex items-center gap-0.5">
          <button
            className="flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-neutral-500 hover:bg-neutral-200"
            onMouseDown={(e) => e.preventDefault()}
            onClick={openMulti}
            title={t("imageGallery.upload")}
          >
            <Upload className="h-3.5 w-3.5" />
            {t("imageGallery.upload")}
          </button>
          <button
            className="ml-1 hidden h-7 w-7 items-center justify-center rounded-md hover:bg-red-100 text-neutral-500 hover:text-red-600 group-hover/gallery:flex"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => deleteNode()}
            title={t("common.delete")}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <input ref={inputRef} type="file" multiple accept="image/*" className="hidden" />
      </div>

      {empty ? (
        <div
          className="flex h-32 items-center justify-center rounded-md border border-dashed border-neutral-300 text-[12px] text-neutral-400 hover:bg-neutral-50 cursor-pointer"
          onClick={openMulti}
        >
          <div className="flex flex-col items-center gap-1">
            <ImagePlus className="h-6 w-6 text-neutral-300" />
            <span>{t("imageGallery.empty").split("。")[0]}。</span>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2" data-gallery-grid>
          <NodeViewContent className="contents gallery-content-host" />
        </div>
      )}
    </NodeViewWrapper>
  );
}
