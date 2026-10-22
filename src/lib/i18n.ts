// 极简 i18n（项目说明书 11 节：UI 文案走 zh-CN/en-US 两套；完整语言切换在 M6 设置页）
// 语言集合见 ./i18n/languages 的注册表：新增语言只需加字典文件 + 一条注册表项。
import { appLang, useAppLang } from "./app-context";
import { dicts, type LangCode } from "./i18n/languages";
import type { MessageKey } from "./i18n/zh";

export { LANGUAGES } from "./i18n/languages";
export type { LangCode } from "./i18n/languages";
export type { MessageKey } from "./i18n/zh";

/** 按当前语言取文案；支持 {placeholder} 插值 */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const lang = appLang();
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
 * 订阅本身由 stores/settings.ts 交进 app-context 的 subscribeLang，hook 在 app-context 里组
 * （lib 不反向依赖 store，见 app-context.ts 头注释）。
 */
export function useLanguage(): LangCode {
  return useAppLang();
}
