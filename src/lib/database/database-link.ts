// url / email 单元格的可点目标：纯函数，与组件分开便于直测（组件测试得按文件另开 jsdom）
// 只放行 http/https 与 mailto——单元格的文本是用户随手填的，
// javascript: / file: 这类串不能顺着「点击打开」递给浏览器或系统外壳。

export type LinkFieldKind = "url" | "email";

/** 该字段类型是否走链接展示（phone 不在列：Windows 上没有可靠的 tel: 处理程序） */
export function isLinkFieldType(type: string): type is LinkFieldKind {
  return type === "url" || type === "email";
}

/** 单元格文本 → 可交给系统默认程序的地址；给不出安全目标时 null（调用方按纯文本渲染） */
export function cellLinkHref(kind: LinkFieldKind, raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (kind === "email") return /^mailto:/i.test(v) ? v : `mailto:${v}`;
  // 没写协议的当 https 补全（用户填「example.com」是常态）；带别的协议一律不点
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}
