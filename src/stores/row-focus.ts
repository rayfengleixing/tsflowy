import { create } from "zustand";

// 搜索命中行的定位状态（阶段 3 #5）：Rust 侧把命中的单元格 row_id 一起带出来，
// 表格/看板/日历据此滚动到那一行并短时高亮。
//
// 与 database store 分开的原因：数据 store 现在是「每个数据库页一份」（并排对照时
// 左右两栏各自持有），而命中行是跨组件树传来的全局瞬时状态——搜索页/命令面板在
// 数据库页之外，无法访问页内的 Provider。

interface RowFocusState {
  /** 当前要高亮的行 id；null = 无 */
  focusRowId: string | null;
  setFocusRow: (rowId: string) => void;
  clearFocusRow: () => void;
}

export const useRowFocusStore = create<RowFocusState>()((set) => ({
  focusRowId: null,
  setFocusRow: (rowId) => set({ focusRowId: rowId }),
  clearFocusRow: () => set({ focusRowId: null }),
}));
