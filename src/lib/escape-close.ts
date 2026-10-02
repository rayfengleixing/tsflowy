// 全局 Esc 的统一出口。
// App 捕获 Esc 后先处理自己管的浮层（命令面板），没人消费时广播这个事件，
// 由持有浮层的视图自己关闭（编辑器查找替换条等）——省得把各处浮层状态提到全局 store。

export const ESCAPE_EVENT = "tsflowy:escape";

export function requestEscapeClose(): void {
  window.dispatchEvent(new Event(ESCAPE_EVENT));
}

/** 订阅全局 Esc，返回取消订阅函数 */
export function onEscapeClose(handler: () => void): () => void {
  window.addEventListener(ESCAPE_EVENT, handler);
  return () => window.removeEventListener(ESCAPE_EVENT, handler);
}
