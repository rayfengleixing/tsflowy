// 表格单元格默认居中的两个 tiptap 扩展（从 EditorPage.tsx 原样搬出）：
// align 属性走 tiptap v3 表格原生支持，导出与粘贴能保留对齐。
import { TableHeader } from "@tiptap/extension-table-header";
import { TableCell } from "@tiptap/extension-table-cell";

// 表格单元格默认居中（tiptap v3 表格原生支持 align 属性，导出/粘贴可保留）
const centeredCellAttrs = () => ({
  align: {
    default: "center",
    parseHTML: (el: HTMLElement) => {
      const v = (el.style.textAlign || (el.getAttribute("align") ?? "")).trim().toLowerCase();
      return v === "left" || v === "center" || v === "right" ? v : "center";
    },
    renderHTML: (attrs: Record<string, unknown>) => {
      const align = attrs.align;
      return typeof align === "string" && align ? { style: `text-align: ${align}` } : {};
    },
  },
});
export const CenteredTableCell = TableCell.extend({
  addAttributes() {
    return { ...this.parent?.(), ...centeredCellAttrs() };
  },
});
export const CenteredTableHeader = TableHeader.extend({
  addAttributes() {
    return { ...this.parent?.(), ...centeredCellAttrs() };
  },
});
