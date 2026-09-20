import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  listFields: vi.fn(),
  listRows: vi.fn(),
  loadCells: vi.fn(),
  renameField: vi.fn(),
  updateFieldOptions: vi.fn(),
  setCell: vi.fn(),
}));
const toastError = vi.hoisted(() => vi.fn());

vi.mock("@/lib/database", () => ({ databaseApi: api }));
vi.mock("@/lib/view-config", () => ({ readViewConfig: () => ({}), patchViewConfig: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }));

import { useDatabaseStore } from "@/stores/database";
import type { DatabaseField } from "@/types/database";
import type { View } from "@/types/models";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const view = (id: string) => ({ id }) as unknown as View;

/** 按调用顺序给三次 API 配好 A、B 两组待决 promise */
function armDeferredLoads(a: ReturnType<typeof deferred>[], b: ReturnType<typeof deferred>[]) {
  const order = [a, b];
  for (const [i, name] of ["listFields", "listRows", "loadCells"].entries()) {
    const method = api[name as keyof typeof api];
    method.mockImplementationOnce(() => order[0][i].promise);
    method.mockImplementationOnce(() => order[1][i].promise);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  useDatabaseStore.setState({ viewId: null, view: null, fields: [], rows: [], cells: {}, loading: false });
});

describe("database store 加载竞态", () => {
  it("慢请求晚到时不覆盖当前视图的数据", async () => {
    const [a, b] = [
      [deferred(), deferred(), deferred()],
      [deferred(), deferred(), deferred()],
    ];
    armDeferredLoads(a, b);

    const store = useDatabaseStore;
    const loadA = store.getState().load(view("A"));
    const loadB = store.getState().load(view("B"));

    // B 先返回并落地
    b[0].resolve([{ id: "b-field" }]);
    b[1].resolve([{ id: "b-row" }]);
    b[2].resolve({});
    await loadB;
    expect(store.getState().viewId).toBe("B");
    expect(store.getState().fields.map((f) => f.id)).toEqual(["b-field"]);

    // A 后返回：必须被丢弃，不能把旧视图的行/字段写进当前视图
    a[0].resolve([{ id: "a-field" }]);
    a[1].resolve([{ id: "a-row" }]);
    a[2].resolve({});
    await loadA;
    expect(store.getState().fields.map((f) => f.id)).toEqual(["b-field"]);
    expect(store.getState().rows.map((r) => r.id)).toEqual(["b-row"]);
    expect(store.getState().viewId).toBe("B");
  });

  it("被切走视图的失败请求不弹错、不清 loading", async () => {
    const [a, b] = [
      [deferred(), deferred(), deferred()],
      [deferred(), deferred(), deferred()],
    ];
    armDeferredLoads(a, b);

    const store = useDatabaseStore;
    const loadA = store
      .getState()
      .load(view("A"))
      .catch(() => undefined);
    const loadB = store
      .getState()
      .load(view("B"))
      .catch(() => undefined);

    b[0].resolve([{ id: "b-field" }]);
    b[1].resolve([]);
    b[2].resolve({});
    await loadB;

    a[0].reject(new Error("ipc cancelled"));
    a[1].reject(new Error("ipc cancelled"));
    a[2].reject(new Error("ipc cancelled"));
    await loadA;

    expect(toastError).not.toHaveBeenCalled();
    expect(store.getState().fields.map((f) => f.id)).toEqual(["b-field"]);
    expect(store.getState().loading).toBe(false);
  });
});

describe("database store 字段改名", () => {
  const field = (id: string, name: string, field_type: string, options = "{}") =>
    ({ id, database_view_id: "v1", name, field_type, options, width: 180, is_hidden: 0, position: 0 }) as DatabaseField;

  it("同步改写引用该字段的公式，避免改名后公式变空", async () => {
    const store = useDatabaseStore;
    store.setState({
      viewId: "v1",
      fields: [
        field("f-price", "价格", "number"),
        field("f-qty", "数量", "number"),
        field("f-total", "总价", "formula", JSON.stringify({ kind: "formula", formula: "{价格} * {数量} + 0" })),
      ],
    });
    api.renameField.mockResolvedValue(undefined);
    api.updateFieldOptions.mockResolvedValue(undefined);

    await store.getState().renameField("f-price", "单价");

    expect(api.updateFieldOptions).toHaveBeenCalledTimes(1);
    const [targetId, opts] = api.updateFieldOptions.mock.calls[0] as [string, { kind: string; formula: string }];
    expect(targetId).toBe("f-total");
    expect(opts.formula).toBe("{单价} * {数量} + 0");
    const total = store.getState().fields.find((f) => f.id === "f-total");
    expect(total && JSON.parse(total.options).formula).toBe("{单价} * {数量} + 0");
  });

  it("没有任何公式引用时不产生额外写入", async () => {
    const store = useDatabaseStore;
    store.setState({ viewId: "v1", fields: [field("f-a", "甲", "text"), field("f-b", "乙", "text")] });
    api.renameField.mockResolvedValue(undefined);
    api.updateFieldOptions.mockResolvedValue(undefined);

    await store.getState().renameField("f-a", "甲改");

    expect(api.updateFieldOptions).not.toHaveBeenCalled();
    expect(store.getState().fields.map((f) => f.name)).toEqual(["甲改", "乙"]);
  });
});

describe("数据库 store 删除选择选项", () => {
  const selectField = (options: unknown[], field_type = "multi_select") =>
    ({
      id: "f-sel",
      database_view_id: "v1",
      name: "类别",
      field_type,
      options: JSON.stringify({ kind: "select", options }),
      width: 180,
      is_hidden: 0,
      position: 0,
    }) as DatabaseField;
  const O1 = { id: "o1", name: "水果", color: "green" };
  const O2 = { id: "o2", name: "蔬菜", color: "blue" };

  it("字段设置里删选项时清掉单元格引用（多选剔除、单选置空）", async () => {
    const store = useDatabaseStore;
    store.setState({
      viewId: "v1",
      fields: [selectField([O1, O2])],
      cells: { r1: { "f-sel": ["o1", "o2"] }, r2: { "f-sel": ["o2"] }, r3: { "f-sel": ["o1"] } },
    });
    api.updateFieldOptions.mockResolvedValue(undefined);
    api.setCell.mockResolvedValue(undefined);

    await store.getState().updateFieldOptions("f-sel", { kind: "select", options: [O1] });

    expect(api.setCell).toHaveBeenCalledTimes(2);
    expect(api.setCell).toHaveBeenCalledWith("r1", "f-sel", ["o1"]);
    expect(api.setCell).toHaveBeenCalledWith("r2", "f-sel", []);
    const r3 = store.getState().cells.r3["f-sel"];
    expect(r3).toEqual(["o1"]); // 未引用被删选项的行原样保留
  });

  it("单元格下拉删选项走同一条清理路径（单选置 null）", async () => {
    const store = useDatabaseStore;
    store.setState({
      viewId: "v1",
      fields: [selectField([O1, O2], "single_select")],
      cells: { r1: { "f-sel": "o2" }, r2: { "f-sel": "o1" } },
    });
    api.updateFieldOptions.mockResolvedValue(undefined);
    api.setCell.mockResolvedValue(undefined);

    await store.getState().removeSelectOption("f-sel", "o2");

    expect(api.updateFieldOptions).toHaveBeenCalledTimes(1);
    expect(api.setCell).toHaveBeenCalledTimes(1);
    expect(api.setCell).toHaveBeenCalledWith("r1", "f-sel", null);
    const opts = JSON.parse(store.getState().fields[0].options) as { options: unknown[] };
    expect(opts.options).toEqual([O1]);
  });
});
