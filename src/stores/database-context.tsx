import { createContext, useContext } from "react";
import { useDatabaseStore, type DatabaseState, type DatabaseStore } from "@/stores/database";

// 数据库页的数据 store 通过 Context 下发：每个 DatabasePage 新建一份实例，
// 并排对照时左右两栏各读各的字段/行/单元格，互不覆盖。
// 默认值取全局实例，保证未包裹 Provider 的场景（含既有单测）行为不变。

const DatabaseStoreContext = createContext<DatabaseStore>(useDatabaseStore);

export const DatabaseStoreProvider = DatabaseStoreContext.Provider;

export function useDbStore(): DatabaseState;
export function useDbStore<U>(selector: (s: DatabaseState) => U): U;
export function useDbStore<U>(selector?: (s: DatabaseState) => U): DatabaseState | U {
  const store = useContext(DatabaseStoreContext);
  return selector ? store(selector) : store();
}

/** 取出当前页的 store 实例本身（需要 getState() 读最新值而非订阅时用） */
export function useDbStoreApi(): DatabaseStore {
  return useContext(DatabaseStoreContext);
}
