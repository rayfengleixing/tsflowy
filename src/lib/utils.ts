import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** 页面名 → 合法文件名（不含扩展名）：替换 Windows 非法字符、规避保留设备名 */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\p{Cc}]/gu, "_")
    .replace(/[. ]+$/, "")
    .trim();
  if (!cleaned) return "_";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned)) return `_${cleaned}`;
  return cleaned;
}

/**
 * 中文/日文输入法正在组词时返回 true：组词期按下的 Enter 是「选词」，不该被当成提交/发送/关闭。
 * 读 React 合成事件的原生属性（原生 KeyboardEvent 直接读 isComposing）；type=number/date 这类原生控件
 * 不产生组词，别给它们硬加这道闸。
 */
export function isComposing(e: { nativeEvent: { isComposing: boolean } }): boolean {
  return e.nativeEvent.isComposing;
}
