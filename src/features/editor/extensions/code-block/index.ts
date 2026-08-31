import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { lowlight } from "@/lib/code-highlight";
import { CodeBlockNodeView } from "./component";

// 自定义代码块（项目说明书 8.2 codeBlock）：浅色底 + 语法高亮 + 语言标识 + 复制
export const CodeBlock = CodeBlockLowlight.extend({
  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockNodeView);
  },
}).configure({ lowlight, languageClassPrefix: "language-" });