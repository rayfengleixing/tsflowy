import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import { logger } from "@/lib/logger";

/**
 * 带重试的 React.lazy：懒加载 chunk 请求偶发失败（WebView2 自定义协议资源加载抖动、
 * 快速切换页面时请求被中断）会让 Suspense 挂不住、抛出错误导致整棵树卸载（白屏）。
 * 这里对 import 失败自动重试 2 次（间隔 300ms），仍失败才把错误抛给上层 ErrorBoundary。
 */
// 与 React.lazy 同签名：泛型约束只能写成 ComponentType<any>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyWithRetry<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
): LazyExoticComponent<T> {
  return lazy(async () => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await factory();
      } catch (e) {
        lastErr = e;
        logger.warn(`lazy.load retry ${attempt + 1}/3 failed`, e);
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    throw lastErr;
  });
}
