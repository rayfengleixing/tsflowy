// 组件用例之间的 store 复位。
//
// zustand 的模块级单例（`useDatabaseStore` 等）在 import 期创建，`cleanup()` 只拆 React 树、不动它们：
// 上一条用例写进单例的数据会带进下一条。踩过的坑长这样：旧用例残留的两字段 `fields` 让粘贴用例把
// 第三列当成「超出最右列」跳过，写得少一格且不报错，只在整文件并行时露头。
//
// 复位口径是「import 期抓一份快照，用例之间整份还原」，不是手写初值清单：
// 清单写漏一项就漏复位一项（此前内联的复位只写了 6 个键，`sorts` / `filters` / `filterMode` 都在外面）。
// 快照取的是 store 创建后的第一份状态，`setState` 浅合并会覆盖 state 类型里声明的每个键，
// 所以以后 store 加字段也不用回来改这里。
//
// 只走 `setState`，不调 action：settings 的 `setLang` 那类 action 会顺手写 localStorage、拉起原生侧同步，
// 复位不该产生这些副作用。
//
// 覆盖不到的：relation 的目标库并发去重集 `inflight` 是模块级的 Set，不在 state 里；它在每次拉取的
// finally 自行出队，不留跨用例残留。
import { useDatabaseStore } from "@/stores/database";
import { useRelationStore } from "@/stores/relation";
import { useRowFocusStore } from "@/stores/row-focus";
import { useSettingsStore } from "@/stores/settings";

const databaseInitial = useDatabaseStore.getState();
const relationInitial = useRelationStore.getState();
const rowFocusInitial = useRowFocusStore.getState();
const settingsInitial = useSettingsStore.getState();

/** 把组件用例会碰到的模块级单例整份还原到 import 期的状态；在 `beforeEach` 里调用 */
export function resetStores() {
  useDatabaseStore.setState(databaseInitial);
  useRelationStore.setState(relationInitial);
  useRowFocusStore.setState(rowFocusInitial);
  useSettingsStore.setState(settingsInitial);
}
