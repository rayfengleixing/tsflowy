import { zh, type MessageKey } from "./zh";
import { en } from "./en";

/**
 * 语言注册表：UI 支持的语言集中登记在此。
 * 新增一门语言 = 新增一个字典文件（Record<MessageKey, string>）+ 在此追加一条，
 * dicts、LangCode 与设置页下拉都会自动跟随，无需改动其它文件。
 * 注意：本模块不依赖 stores，避免与 i18n.ts 形成运行时循环依赖。
 */
export const LANGUAGES = [
  { code: "zh-CN", label: "简体中文", dict: zh },
  { code: "en-US", label: "English", dict: en },
] as const;

/** 由注册表推导的语言代码联合类型 */
export type LangCode = (typeof LANGUAGES)[number]["code"];

/** 语言代码 → 文案字典（由注册表与字典文件构造） */
export const dicts = Object.fromEntries(LANGUAGES.map((l) => [l.code, l.dict] as const)) as Record<
  LangCode,
  Record<MessageKey, string>
>;
