import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { lowlight } from "@/lib/code-highlight";
import { CodeBlockNodeView } from "./component";

// 自定义代码块：语法高亮 + 语言标识（双击改）+ 复制；工具栏与代码背景同色（统一）
export const CodeBlock = CodeBlockLowlight.extend({
  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockNodeView);
  },
}).configure({ lowlight, languageClassPrefix: "language-" });