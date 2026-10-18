// tsflowy:// 深链前端接线。
// 路径：冷启动 = 插件 getCurrent() 拉启动 URL；热启动 = 插件 onOpenUrl 事件
// （App 未运行时协议直接拉起本进程，argv 由 deep-link 插件解析；已运行时新进程被
// single-instance 拦截，Rust 侧把 argv 里的 URL 转成同名 deep-link://new-url 事件，见 src-tauri/src/{lib,desktop}.rs）。
import { useWorkspaceStore } from "@/stores/workspace";
import { useRowFocusStore } from "@/stores/row-focus";
import { findNode } from "@/lib/tree";
import { logger } from "@/lib/logger";

/** 冷启动排队等待树加载的超时：超时后认定目标页不存在（已删除/ID 过时），放弃并记日志 */
const PENDING_TIMEOUT_MS = 15000;

export interface DeepLinkTarget {
  viewId: string;
  /** `?row=<行 id>` 带来的行级目标；null = 只定位到页 */
  rowId: string | null;
}

/**
 * 行 id 只认 uuid 形态：深链是从外部浏览器点进来的，脏值会拼坏 rowFocus 里的
 * `[data-row-id="…"]` 选择器（属性值里的引号直接让 querySelector 抛错）。
 */
const ROW_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const decode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/**
 * 解析 `tsflowy://page/<viewId>[?row=<rowId>]` 形式的深链；无法解析返回 null。
 * 容忍大小写宿主与尾部斜杠；hash 整段忽略，query 里只认 row，其余键（如旧的 ?mode=edit）不参与定位。
 */
export function parseDeepLink(raw: string): DeepLinkTarget | null {
  const m = /^tsflowy:\/\/page\/([^/?#]+)(?:([/?#])(.*))?$/i.exec(raw.trim());
  if (!m) return null;
  // 只有以 `?` 起头的那一段才是 query；紧跟 `#` 的整串是 hash，不参与定位
  const query = m[2] === "?" ? (m[3] || "").split("#")[0] : "";
  const rowId = new URLSearchParams(query).get("row");
  return { viewId: decode(m[1]), rowId: rowId !== null && ROW_ID_RE.test(rowId) ? rowId : null };
}

/** 行级 permalink：外部程序点它即拉起本 App，两个 id 都按 URL 组件转义 */
export function rowPermalink(viewId: string, rowId: string): string {
  return `tsflowy://page/${encodeURIComponent(viewId)}?row=${encodeURIComponent(rowId)}`;
}

/** 站内跳行（关联 / 反向关系胶囊）：打开对端库并定位那一行。
 *  走与深链同一条排队逻辑——目标页此刻不在树里（比如刚被关掉）也会等它出现再打开，
 *  而不是静默什么都不做。 */
export function openRowInView(viewId: string, rowId: string): void {
  openViewWhenReady({ viewId, rowId });
}

/** 深链可能在树加载完成前到达（冷启动）：排队，树里出现该页面即打开；返回取消函数 */
function openViewWhenReady(target: DeepLinkTarget): () => void {
  let settled = false;
  const check = () => {
    if (settled) return;
    const s = useWorkspaceStore.getState();
    if (findNode(s.tree, target.viewId)) {
      settle();
      s.openView(target.viewId);
      // 行级定位复用搜索命中那一套：视图侧已负责滚动到行、展开折叠的分组与短时高亮
      if (target.rowId) useRowFocusStore.getState().setFocusRow(target.rowId);
    }
  };
  const unsubscribe = useWorkspaceStore.subscribe(check);
  const timer = setTimeout(() => {
    if (!settled) {
      settle();
      logger.warn("deep-link", `view not found in tree, ignored`, target.viewId);
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
    const target = parseDeepLink(raw ?? "");
    if (target) register(openViewWhenReady(target));
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
