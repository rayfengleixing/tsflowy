// tsflowy:// 深链前端接线。
// 路径：冷启动 = 插件 getCurrent() 拉启动 URL；热启动 = 插件 onOpenUrl 事件
// （App 未运行时协议直接拉起本进程，argv 由 deep-link 插件解析；已运行时新进程被
// single-instance 拦截，Rust 侧把 argv 里的 URL 转成同名 deep-link://new-url 事件，见 src-tauri/src/{lib,desktop}.rs）。
import { useWorkspaceStore } from "@/stores/workspace";
import { findNode } from "@/lib/tree";
import { logger } from "@/lib/logger";

/** 冷启动排队等待树加载的超时：超时后认定目标页不存在（已删除/ID 过时），放弃并记日志 */
const PENDING_TIMEOUT_MS = 15000;

/**
 * 解析 `tsflowy://page/<viewId>` 形式的深链，返回 viewId；无法解析返回 null。
 * 容忍大小写宿主、尾部斜杠与 query/hash（query 部分不参与视图定位）。
 */
export function parseDeepLinkViewId(raw: string): string | null {
  const m = /^tsflowy:\/\/page\/([^/?#]+)(?:[/?#].*)?$/i.exec(raw.trim());
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/** 深链可能在树加载完成前到达（冷启动）：排队，树里出现该页面即打开；返回取消函数 */
function openViewWhenReady(viewId: string): () => void {
  let settled = false;
  const check = () => {
    if (settled) return;
    const s = useWorkspaceStore.getState();
    if (findNode(s.tree, viewId)) {
      settle();
      s.openView(viewId);
    }
  };
  const unsubscribe = useWorkspaceStore.subscribe(check);
  const timer = setTimeout(() => {
    if (!settled) {
      settle();
      logger.warn("deep-link", `view not found in tree, ignored`, viewId);
    }
  }, PENDING_TIMEOUT_MS);
  function settle() {
    settled = true;
    unsubscribe();
    clearTimeout(timer);
  }
  check();
  return () => {
    if (!settled) settle();
  };
}

/** App 挂载时调用一次；返回注销函数（StrictMode 双挂载安全） */
export async function setupDeepLink(): Promise<() => void> {
  const { getCurrent, onOpenUrl } = await import("@tauri-apps/plugin-deep-link");
  const disposers: (() => void)[] = [];
  let disposed = false;
  const register = (dispose: () => void) => {
    if (disposed) dispose();
    else disposers.push(dispose);
  };
  const open = (raw: string | undefined) => {
    const viewId = parseDeepLinkViewId(raw ?? "");
    if (viewId) register(openViewWhenReady(viewId));
  };
  register(await onOpenUrl((urls) => open(urls[0])));
  getCurrent()
    .then((urls) => open(urls?.[0]))
    .catch((e: unknown) => logger.warn("deep-link", "getCurrent failed", e));
  return () => {
    disposed = true;
    for (const d of disposers) d();
  };
}
