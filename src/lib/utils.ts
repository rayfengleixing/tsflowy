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
