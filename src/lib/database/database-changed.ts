// 表格数据的「外部改动」通知：给绕开 useDatabaseStore 直接写库的调用方用。
//
// 为什么需要：AI 助手的写动作（加行/改行/删行）走 databaseApi 直写，不经过某个页面
// 自己的 store 实例，而各视图只在挂载/换页时 load 一次 —— 于是「应用成功」的卡片配着
// 一动不动的表格。并排对照时每个 DatabasePage 各持一份 store 实例，所以这里做进程内
// 广播而不是找个「全局 store」：谁正显示这张表，谁自己重新拉取。

type Listener = (hostViewIds: string[]) => void;

const listeners = new Set<Listener>();

/** 注册监听；返回取消函数（订阅方在卸载时调用，否则集合会一直攥着那份 store 实例） */
export function onDatabaseChanged(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 通知这些宿主视图的数据变了（派生视图的数据都挂在宿主上，按宿主 id 通知） */
export function notifyDatabaseChanged(hostViewIds: string[]): void {
  if (hostViewIds.length === 0) return;
  for (const fn of [...listeners]) fn(hostViewIds);
}
