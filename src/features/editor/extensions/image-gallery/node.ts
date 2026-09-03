import { mergeAttributes, Node } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { ImageGalleryNodeView } from "./component";

// 多图相册容器（说明书 8.2 M3：子节点是已注册的 image）
export const ImageGallery = Node.create({
  name: "imageGallery",
  group: "block",
  content: "image*",
  defining: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {};
  },

  parseHTML() {
    return [{ tag: "div[data-image-gallery]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes({ "data-image-gallery": "" }, HTMLAttributes)];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ImageGalleryNodeView);
  },
});
