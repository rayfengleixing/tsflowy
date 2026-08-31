import { CodeBlock as CodeBlockBase } from "@tiptap/extension-code-block";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { CodeBlockNodeView } from "./component";

// 自定义代码块（项目说明书 8.2 codeBlock）：单色文本 + 语言标识（可双击改）+ 复制
// 不做多色语法高亮（lowlight decoration 会分色，故用基础 CodeBlock 保持统一颜色）
export const CodeBlock = CodeBlockBase.extend({
  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockNodeView);
  },
});