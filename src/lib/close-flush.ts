// 关窗前统一落盘：Tauri 关窗不保证 beforeunload 里的异步 IPC 跑完（webview 可能在
// invoke 返回前被销毁）。App 在 onCloseRequested 里 preventDefault 后 await flushAllForClose()
// 再 destroy；各数据源（编辑器文档 / UI 状态）挂载时注册自己的冲刷函数。

export type CloseFlush = () => Promise<void> | void;

const flushers = new Set<CloseFlush>();

/** 注册一个关窗前冲刷函数；返回注销函数 */
export function registerCloseFlush(fn: CloseFlush): () => void {
  flushers.add(fn);
  return () => {
    flushers.delete(fn);
  };
}

/** 冲刷所有注册项；单项失败不阻断其余。返回是否全部成功（失败项各自 toast，这里只汇总） */
export async function flushAllForClose(): Promise<boolean> {
  const results = await Promise.allSettled([...flushers].map((fn) => Promise.resolve(fn())));
  return results.every((r) => r.status === "fulfilled");
}
