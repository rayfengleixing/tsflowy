// 页面属性 API（Phase 4.2 - Page Properties）
//
// 文档顶部 chips：text/date/single_select/multi_select/number/checkbox。
// 所有写操作 upsert（PRIMARY KEY (view_id,key)），读操作按 position ASC 排序。
// 持久化走 Rust 领域命令（pp_list/pp_set/pp_remove/pp_rename）。
import { invoke } from "@tauri-apps/api/core";

export type PagePropertyFieldType = "text" | "date" | "single_select" | "multi_select" | "number" | "checkbox";

export interface PagePropertyRow {
  view_id: string;
  key: string;
  /** value：text=原文；date=YYYY-MM-DD；single=选项名；multi=JSON数组字符串；number=数字字符串；checkbox='1'/'0' */
  value: string;
  field_type: PagePropertyFieldType;
  position: number;
}

/** view 全部属性，按 position 排序 */
export const pagePropertiesApi = {
  async list(viewId: string): Promise<PagePropertyRow[]> {
    return invoke<PagePropertyRow[]>("pp_list", { viewId });
  },

  async set(viewId: string, key: string, value: string, fieldType: PagePropertyFieldType): Promise<void> {
    await invoke("pp_set", { viewId, key, value, fieldType });
  },

  async remove(viewId: string, key: string): Promise<void> {
    await invoke("pp_remove", { viewId, key });
  },

  async rename(viewId: string, oldKey: string, newKey: string): Promise<void> {
    if (!newKey.trim() || oldKey === newKey) return;
    await invoke("pp_rename", { viewId, oldKey, newKey });
  },
};
