import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  listFields: vi.fn(),
  listRows: vi.fn(),
  loadCells: vi.fn(),
  renameField: vi.fn(),
  updateFieldOptions: vi.fn(),
  pairRelationTarget: vi.fn(),
  setCell: vi.fn(),
  deleteRow: vi.fn(),
  deleteRows: vi.fn(),
  listTrash: vi.fn(),
  restoreRow: vi.fn(),
  purgeRow: vi.fn(),
  purgeTrash: vi.fn(),
  createRows: vi.fn(),
  setCellsMany: vi.fn(),
}));
const toastError = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());

vi.mock("@/lib/database", () => ({ databaseApi: api }));
vi.mock("@/lib/view-config", () => ({ readViewConfig: () => ({}), patchViewConfig: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: toastError, success: toastSuccess } }));

import { bindDatabaseChanges, createDatabaseStore, useDatabaseStore } from "@/stores/database";
import { useRelationStore } from "@/stores/relation";
import { notifyDatabaseChanged } from "@/lib/database-changed";
import type { DatabaseField, DatabaseRow, DatabaseTrashRow } from "@/types/database";
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
  useDatabaseStore.setState({
    viewId: null,
    view: null,
    fields: [],
    rows: [],
    cells: {},
    trash: [],
    loading: false,
  });
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
    expect(total && (JSON.parse(total.options) as { formula: string }).formula).toBe("{单价} * {数量} + 0");
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

  it("空白名不落库；带空格的名字去空格后再写入与改写公式", async () => {
    const store = useDatabaseStore;
    store.setState({
      viewId: "v1",
      fields: [
        field("f-a", "甲", "text"),
        field("f-c", "丙", "formula", JSON.stringify({ kind: "formula", formula: "{甲} + 1" })),
      ],
    });
    api.renameField.mockResolvedValue(undefined);
    api.updateFieldOptions.mockResolvedValue(undefined);

    // 纯空白：直接丢弃，持久层入口校验会拒空，不该把报错抛到 UI
    await store.getState().renameField("f-a", "   ");
    expect(api.renameField).not.toHaveBeenCalled();
    expect(store.getState().fields[0].name).toBe("甲");

    await store.getState().renameField("f-a", "  甲改  ");
    expect(api.renameField).toHaveBeenCalledWith("f-a", "甲改");
    expect(store.getState().fields[0].name).toBe("甲改");
    const [, opts] = api.updateFieldOptions.mock.calls[0] as [string, { formula: string }];
    expect(opts.formula).toBe("{甲改} + 1");
  });
});

describe("数据库 store 多选行操作", () => {
  const row = (id: string, position: number) =>
    ({ id, database_view_id: "v1", position, document_id: null, created_at: 1, updated_at: 1 }) as DatabaseRow;

  it("批量删行：一次 IPC，行与单元格缓存同步清掉", async () => {
    const store = useDatabaseStore;
    store.setState({
      viewId: "v1",
      rows: [row("r1", 0), row("r2", 1), row("r3", 2)],
      cells: { r1: { f1: "a" }, r2: { f1: "b" } },
    });
    api.deleteRows.mockResolvedValue(2);

    const n = await store.getState().removeRows(["r1", "r2"]);

    expect(api.deleteRows).toHaveBeenCalledWith(["r1", "r2"]);
    expect(n).toBe(2);
    expect(store.getState().rows.map((r) => r.id)).toEqual(["r3"]);
    expect(store.getState().rows.map((r) => r.position)).toEqual([0]); // 删后压紧，行号不跳号
    expect(store.getState().cells).toEqual({});
  });

  it("单行删除：剩余行 position 压紧（行号不跳号）", async () => {
    const store = useDatabaseStore;
    store.setState({
      viewId: "v1",
      rows: [row("r1", 0), row("r2", 1), row("r3", 2)],
      cells: {},
    });
    api.deleteRow.mockResolvedValue(undefined);

    await store.getState().removeRow("r2");

    expect(api.deleteRow).toHaveBeenCalledWith("r2");
    expect(store.getState().rows.map((r) => [r.id, r.position])).toEqual([
      ["r1", 0],
      ["r3", 1],
    ]);
  });

  it("复制所选行：按表格行序建行并搬运单元格值（与勾选顺序无关）", async () => {
    const store = useDatabaseStore;
    store.setState({
      viewId: "v1",
      rows: [row("r1", 0), row("r2", 1), row("r3", 2)],
      cells: { r1: { f1: "a" }, r2: { f1: "b", f2: 2 }, r3: { f1: "c" } },
    });
    api.createRows.mockResolvedValue([row("n1", 3), row("n2", 4)]);
    api.setCellsMany.mockResolvedValue(3);

    const created = await store.getState().duplicateRows(["r2", "r1"]);

    expect(api.createRows).toHaveBeenCalledWith("v1", 2);
    // 勾选顺序是 r2、r1，但落库顺序按表格行序：n1 ← r1，n2 ← r2
    expect(api.setCellsMany).toHaveBeenCalledWith([
      { rowId: "n1", fieldId: "f1", value: "a" },
      { rowId: "n2", fieldId: "f1", value: "b" },
      { rowId: "n2", fieldId: "f2", value: 2 },
    ]);
    expect(created.map((r) => r.id)).toEqual(["n1", "n2"]);
    expect(store.getState().rows.map((r) => r.id)).toEqual(["r1", "r2", "r3", "n1", "n2"]);
    expect(store.getState().cells.n2).toEqual({ f1: "b", f2: 2 });
  });

  it("复制空行：不产生多余的单元格写入", async () => {
    const store = useDatabaseStore;
    store.setState({ viewId: "v1", rows: [row("r1", 0)], cells: {} });
    api.createRows.mockResolvedValue([row("n1", 1)]);

    await store.getState().duplicateRows(["r1"]);

    expect(api.setCellsMany).not.toHaveBeenCalled();
    expect(store.getState().rows.map((r) => r.id)).toEqual(["r1", "n1"]);
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

describe("数据库 store 行回收站", () => {
  const entry = (id: string, title: string) =>
    ({ id, database_view_id: "v1", document_id: null, deleted_at: 1, title }) as DatabaseTrashRow;

  it("打开回收站才拉列表；未选中视图时不发 IPC", async () => {
    const store = useDatabaseStore;
    store.setState({ viewId: null });
    await store.getState().loadTrash();
    expect(api.listTrash).not.toHaveBeenCalled();

    store.setState({ viewId: "v1" });
    api.listTrash.mockResolvedValue([entry("r9", "旧行")]);
    await store.getState().loadTrash();
    expect(api.listTrash).toHaveBeenCalledWith("v1");
    expect(store.getState().trash.map((r) => r.id)).toEqual(["r9"]);
  });

  it("恢复一行：整表重拉（行号与单元格交回后端），再刷新回收站", async () => {
    const store = useDatabaseStore;
    store.setState({
      viewId: "v1",
      view: view("v1"),
      rows: [],
      cells: {},
      trash: [entry("r9", "旧行")],
    });
    api.restoreRow.mockResolvedValue(undefined);
    api.listFields.mockResolvedValue([]);
    api.listRows.mockResolvedValue([
      { id: "r9", database_view_id: "v1", position: 0, document_id: null, created_at: 1, updated_at: 1 },
    ]);
    api.loadCells.mockResolvedValue({ r9: { f1: "旧行" } });
    api.listTrash.mockResolvedValue([]);

    await store.getState().restoreRow("r9");

    expect(api.restoreRow).toHaveBeenCalledWith("r9");
    expect(store.getState().rows.map((r) => r.id)).toEqual(["r9"]);
    expect(store.getState().cells.r9.f1).toBe("旧行");
    expect(store.getState().trash).toEqual([]);
  });

  it("彻底删除：只从回收站列表摘掉，表格行不受影响", async () => {
    const store = useDatabaseStore;
    store.setState({
      viewId: "v1",
      rows: [],
      trash: [entry("r9", "旧行"), entry("r8", "更早")],
    });
    api.purgeRow.mockResolvedValue(undefined);

    await store.getState().purgeRow("r9");

    expect(api.purgeRow).toHaveBeenCalledWith("r9");
    expect(store.getState().trash.map((r) => r.id)).toEqual(["r8"]);
    expect(api.listRows).not.toHaveBeenCalled();
  });

  it("清空回收站：返回彻底删除的行数并清空列表", async () => {
    const store = useDatabaseStore;
    store.setState({ viewId: "v1", trash: [entry("r9", "旧行")] });
    api.purgeTrash.mockResolvedValue(1);

    expect(await store.getState().purgeTrash()).toBe(1);
    expect(api.purgeTrash).toHaveBeenCalledWith("v1");
    expect(store.getState().trash).toEqual([]);
  });
});

describe("database store 写入类型闸门", () => {
  const field = (id: string, name: string, field_type: string) =>
    ({
      id,
      database_view_id: "v1",
      name,
      field_type,
      options: "{}",
      width: 180,
      is_hidden: 0,
      position: 0,
    }) as DatabaseField;

  it("值与字段类型不符时不落库，也不写进单元格缓存", async () => {
    const store = useDatabaseStore;
    store.setState({ viewId: "v1", fields: [field("f-num", "价格", "number")], cells: { r1: { "f-num": 1 } } });

    await store.getState().setCell("r1", "f-num", "三千");

    expect(api.setCell).not.toHaveBeenCalled();
    expect(store.getState().cells.r1["f-num"]).toBe(1);
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it("合规值与空值照常写入；只读列不做校验", async () => {
    const store = useDatabaseStore;
    store.setState({
      viewId: "v1",
      fields: [field("f-num", "价格", "number"), field("f-total", "总价", "formula")],
      cells: {},
    });
    api.setCell.mockResolvedValue(undefined);

    await store.getState().setCell("r1", "f-num", 2);
    await store.getState().setCell("r1", "f-num", null);
    await store.getState().setCell("r1", "f-total", "文本公式值");

    expect(api.setCell).toHaveBeenCalledTimes(3);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("批量写入只剔除类型不符的那几格，其余照常落库", async () => {
    const store = useDatabaseStore;
    store.setState({
      viewId: "v1",
      fields: [field("f-num", "价格", "number"), field("f-text", "备注", "text")],
      cells: {},
    });
    api.setCellsMany.mockResolvedValue(1);

    await store.getState().setCellsMany([
      { rowId: "r1", fieldId: "f-num", value: "abc" },
      { rowId: "r1", fieldId: "f-text", value: "ok" },
    ]);

    expect(api.setCellsMany).toHaveBeenCalledWith([{ rowId: "r1", fieldId: "f-text", value: "ok" }]);
    expect(store.getState().cells.r1).toEqual({ "f-text": "ok" });
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it("字段还没加载时不拦：交给持久层报错，别在这里误判成非法值", async () => {
    const store = useDatabaseStore;
    store.setState({ viewId: "v1", fields: [], cells: {} });
    api.setCell.mockResolvedValue(undefined);

    await store.getState().setCell("r1", "f-unknown", "abc");

    expect(api.setCell).toHaveBeenCalledWith("r1", "f-unknown", "abc");
    expect(toastError).not.toHaveBeenCalled();
  });
});

describe("外部改库通知（AI 的写动作绕开本 store 直接落库）", () => {
  it("只有正显示这张表的实例重取，解绑之后不再被打扰", async () => {
    const store = createDatabaseStore();
    api.listFields.mockResolvedValue([]);
    api.listRows.mockResolvedValue([]);
    api.loadCells.mockResolvedValue({});
    await store.getState().load(view("host1"));
    expect(api.listFields).toHaveBeenCalledTimes(1);

    const off = bindDatabaseChanges(store);
    notifyDatabaseChanged(["别的表"]);
    await new Promise((r) => setTimeout(r, 0));
    expect(api.listFields).toHaveBeenCalledTimes(1);

    notifyDatabaseChanged(["host1"]);
    await vi.waitFor(() => expect(api.listFields).toHaveBeenCalledTimes(2));
    off();
    notifyDatabaseChanged(["host1"]);
    await new Promise((r) => setTimeout(r, 0));
    expect(api.listFields).toHaveBeenCalledTimes(2);
  });
});

describe("关联列改目标表：与对端反向列一起落库", () => {
  const relField = (target: string): DatabaseField => ({
    id: "f-rel",
    database_view_id: "v1",
    name: "项目",
    field_type: "relation",
    options: JSON.stringify({ kind: "relation", target_view_id: target }),
    width: 180,
    is_hidden: 0,
    position: 0,
  });

  /** Rust 侧写回后的本列（target_view_id 已折算成宿主 id，paired_field_id 由它生成） */
  const pairedField = (reverseId: string): DatabaseField => ({
    ...relField("v2"),
    options: JSON.stringify({ kind: "relation", target_view_id: "v2", paired_field_id: reverseId }),
  });

  const optionsIn = (field: DatabaseField): Record<string, unknown> =>
    JSON.parse(field.options) as Record<string, unknown>;

  const arm = (fields: DatabaseField[]) => {
    useRelationStore.setState({ data: { v2: { fields: [], rows: [], cells: {} } }, revision: 0 });
    useDatabaseStore.setState({ viewId: "v1", view: view("v1"), fields, cells: {}, rows: [] });
  };

  it("走配对命令而不是单独写本列（两步写会留半配对）", async () => {
    const store = useDatabaseStore;
    arm([relField("")]);
    api.pairRelationTarget.mockImplementation((_f: string, _t: string, reverseId: string) =>
      Promise.resolve({ relation_field: pairedField(reverseId), reverse_field_id: reverseId }),
    );

    await store.getState().updateFieldOptions("f-rel", { kind: "relation", target_view_id: "v2" });

    expect(api.updateFieldOptions).not.toHaveBeenCalled();
    const [fieldId, targetViewId, reverseId, reverseName] = api.pairRelationTarget.mock.calls[0] as [
      string,
      string,
      string,
      string,
    ];
    expect([fieldId, targetViewId, reverseName]).toEqual(["f-rel", "v2", "项目"]); // 反向列沿用本列名
    expect(typeof reverseId).toBe("string");
    expect(optionsIn(store.getState().fields[0]).paired_field_id).toBe(reverseId);
    // 对端表多了一条列：它在 relation 缓存里的旧快照必须失效
    expect(useRelationStore.getState().data.v2).toBeUndefined();
    expect(toastSuccess).toHaveBeenCalledWith(expect.stringContaining("项目"));
  });

  it("复用对端已有反向列时不提示「已新建」", async () => {
    const store = useDatabaseStore;
    arm([relField("v2")]);
    api.pairRelationTarget.mockResolvedValue({ relation_field: pairedField("rv-old"), reverse_field_id: "rv-old" });

    await store.getState().updateFieldOptions("f-rel", { kind: "relation", target_view_id: "v2" });

    expect(toastSuccess).not.toHaveBeenCalled();
    expect(store.getState().fields[0].id).toBe("f-rel");
  });

  it("配对失败保留原配置，不乐观写入新目标", async () => {
    const store = useDatabaseStore;
    const original = relField("");
    arm([original]);
    api.pairRelationTarget.mockRejectedValue(new Error("目标表不存在"));

    await store.getState().updateFieldOptions("f-rel", { kind: "relation", target_view_id: "v9" });

    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("目标表不存在"));
    expect(store.getState().fields[0]).toBe(original);
    expect(optionsIn(store.getState().fields[0]).target_view_id).toBe("");
  });

  it("未选目标表时仍按普通 options 保存（没有对端可配对）", async () => {
    const store = useDatabaseStore;
    arm([relField("v2")]);
    api.updateFieldOptions.mockResolvedValue(undefined);

    await store.getState().updateFieldOptions("f-rel", { kind: "relation", target_view_id: "" });

    expect(api.pairRelationTarget).not.toHaveBeenCalled();
    expect(api.updateFieldOptions).toHaveBeenCalledTimes(1);
  });
});
