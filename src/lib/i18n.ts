// 极简 i18n（项目说明书 11 节：UI 文案走 zh-CN/en-US 两套；完整语言切换在 M6 设置页）
import { useSettingsStore } from "@/stores/settings";
import { zh, type MessageKey } from "./i18n/zh";
import { en } from "./i18n/en";

export type { MessageKey } from "./i18n/zh";

const dicts: Record<string, Record<MessageKey, string>> = {
  "zh-CN": zh,
  "en-US": en,
};

/** 按当前语言取文案；支持 {placeholder} 插值 */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const lang = useSettingsStore.getState().lang;
  let s = dicts[lang][key];
  if (params) {
    for (const [k, val] of Object.entries(params)) {
      s = s.replace(`{${k}}`, String(val));
    }
  }
  return s;
}

/**
 * 订阅当前语言。t() 读 getState 不建立订阅，切换语言后必须由某个已挂载组件
 * 订阅 lang 才能触发重渲染刷新文案——在 App 顶层调用一次，整棵树（无 memo 边界）随之更新。
 */
export function useLanguage(): "zh-CN" | "en-US" {
  return useSettingsStore((s) => s.lang);
}
