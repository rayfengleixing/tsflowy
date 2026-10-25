// resetStores 自己的守卫。漏复位的表现是组件用例之间串数据（并行时随机红），而不是这里报错，
// 所以断言打在「脏了还能回去」上：四份单例各脏一遍，复位后与 import 期那份逐键深比较。
// 不点字段名是刻意的——复位靠快照整份还原，全覆盖与否一次 toEqual 就见分晓，写死清单反而复现不了漏键。
import { describe, expect, it } from "vitest";

import { useDatabaseStore } from "@/stores/database";
import { useRelationStore } from "@/stores/relation";
import { useRowFocusStore } from "@/stores/row-focus";
import { useSettingsStore } from "@/stores/settings";
import { resetStores } from "./store-reset";

describe("resetStores 把组件用例会碰的模块级单例还原到 import 期", () => {
  it("四份 store 脏完再复位，逐份等于各自的第一份状态", () => {
    const databaseInitial = useDatabaseStore.getState();
    const relationInitial = useRelationStore.getState();
    const rowFocusInitial = useRowFocusStore.getState();
    const settingsInitial = useSettingsStore.getState();

    useDatabaseStore.setState({
      viewId: "v-1",
      loading: true,
      fields: [],
      rows: [],
      cells: { "r-1": { "f-1": "甲" } },
      sorts: [{ field_id: "f-1", dir: "desc" }],
      filters: [{ id: "g-1", mode: "or", children: [] }],
      filterMode: "or",
    });
    useRelationStore.setState({ data: { "v-t": { fields: [], rows: [], cells: {} } }, revision: 7 });
    useRowFocusStore.setState({ focusRowId: "r-9" });
    useSettingsStore.setState({ lang: "en-US", typewriter: true });

    resetStores();

    expect(useDatabaseStore.getState()).toEqual(databaseInitial);
    expect(useRelationStore.getState()).toEqual(relationInitial);
    expect(useRowFocusStore.getState()).toEqual(rowFocusInitial);
    expect(useSettingsStore.getState()).toEqual(settingsInitial);
  });

  it("内联清单漏掉的那几个键也回到初始值（不只是 fields/rows/cells）", () => {
    useDatabaseStore.setState({
      sorts: [{ field_id: "f-1", dir: "asc" }],
      filters: [],
      filterMode: "or",
      viewId: "v-1",
    });

    resetStores();

    const state = useDatabaseStore.getState();
    expect(state.sorts).toEqual([]);
    expect(state.filters).toEqual([]);
    expect(state.filterMode).toBe("and");
    expect(state.viewId).toBeNull();
  });
});
