// @vitest-environment jsdom
// grid-io-slice 的直接用例。切片是 C 批从 GridView 体内搬出来的「数据进出」一簇，此前只被
// `grid-view.test.tsx` 经由组件间接执行（导出、导入、粘贴、追加各一条走得通的路径），断言全落在
// 「发给 Rust 的参数」上——切片自己的闸门、对话框取消、各条 catch 与 skipped 分档没有一条指着它。
// 这里直接把 createGridIoSlice 造出来的函数拿来调，注入当一次渲染的快照，钉：
// 取消不许留下任何写入与出声；粘贴的六道闸门各在哪一步收手（尤其「没有锚点时不拦默认粘贴」）；
// skipped 的三档（越界列 / 只读列 / 补建失败）各进哪个数；建新表与追加各自的失败分岔。
// I/O 全换替身（ipc-dialog 的 save/open、invoke、lib/db 的 viewApi+newId、workspace、sonner、logger），
// 纯逻辑保持真实：parseTsv / pasteCell / importCell / resolveExportCells / mapWithConcurrency 都按真的算，
// 这样钉的是「切片怎么指挥它们」，不是把 csv.ts 自己的用例再抄一遍。
// 文案用 key 恒等替身（`@/lib/i18n`）：断的是走了哪条分岔，不是中文措辞。
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createGridIoSlice, type GridImportPlan } from "./grid-io-slice";
import type { DatabaseState, DatabaseStore } from "@/stores/database";
import type { CellValue, DatabaseField, DatabaseRow, FieldType } from "@/types/database";
import type { View } from "@/types/models";

type CommandHandler = ((args?: Record<string, unknown>) => unknown) | Error | undefined;

const h = vi.hoisted(() => {
  // 命令 → 返回值；值是 Error 就当作该命令失败（测各条 catch），是函数就按参数现算。
  // 用 Map 不用 Record：复位时整份清空，不必逐键 delete（那条写法过不了 lint）。
  const handlers = new Map<string, CommandHandler>();
  const ws: { currentWorkspaceId: string | null; reloaded: number; opened: string[] } = {
    currentWorkspaceId: "ws-1",
    reloaded: 0,
    opened: [],
  };
  return {
    handlers,
    ws,
    calls: [] as { cmd: string; args?: unknown[] }[],
    // 替身一律给真的函数体（不是类型位）：写 `vi.fn((_o?: X) => Promise<string|null>)` 会让
    // 推断出的解析类型塌成 PromiseConstructor，后面每条 mockResolvedValue 都变成 tsc 错误。
    // 参数也要写进函数体里（不是只写类型）：`vi.fn((): Promise<...> => ...)` 会把 calls 的元素形状定成空元组。
    save: vi.fn((_opts?: Record<string, unknown>): Promise<string | null> => Promise.resolve(null)),
    open: vi.fn((_opts?: Record<string, unknown>): Promise<string | string[] | null> => Promise.resolve(null)),
    invoke: vi.fn(),
    viewCreate: vi.fn(),
    newId: vi.fn((): string => ""),
    addRows: vi.fn(),
    setCellsMany: vi.fn(),
    addSelectOption: vi.fn(),
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
    toastWarning: vi.fn(),
    toastInfo: vi.fn(),
    loggerError: vi.fn(),
    loggerWarn: vi.fn(),
  };
});

vi.mock("@/lib/ipc-dialog", () => ({ save: h.save, open: h.open }));
vi.mock("@/lib/invoke", () => ({ invoke: h.invoke }));
// 真的 `@/lib/db` 顺 invoke 走 auto-sync（那个模块加载时就读一次配置），切片只用 viewApi.create 与 newId
vi.mock("@/lib/db", () => ({ viewApi: { create: h.viewCreate }, newId: h.newId }));
vi.mock("@/stores/workspace", () => ({
  useWorkspaceStore: {
    getState: () => ({
      currentWorkspaceId: h.ws.currentWorkspaceId,
      reload: () => {
        h.ws.reloaded += 1;
        return Promise.resolve();
      },
      openView: (id: string) => {
        h.ws.opened.push(id);
      },
    }),
  },
}));
vi.mock("sonner", () => ({
  toast: { success: h.toastSuccess, error: h.toastError, warning: h.toastWarning, info: h.toastInfo },
}));
vi.mock("@/lib/logger", () => ({ logger: { error: h.loggerError, warn: h.loggerWarn, info: vi.fn() } }));
vi.mock("@/lib/i18n", () => ({
  t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
}));

/** 一次渲染的快照形状：与 GridView 递给切片的那一份同构，只填本文件用得上的键 */
type SliceCtx = Parameters<typeof createGridIoSlice>[0];

const field = (id: string, name: string, type: FieldType, over: Partial<DatabaseField> = {}): DatabaseField => ({
  id,
  database_view_id: "v-grid",
  name,
  field_type: type,
  options: "",
  width: 160,
  is_hidden: 0,
  position: 0,
  ...over,
});

const row = (id: string, position: number): DatabaseRow => ({
  id,
  database_view_id: "v-grid",
  position,
  document_id: null,
  parent_id: null,
  created_at: 0,
  updated_at: 0,
});

/** select 形态的 FieldOptions 载荷：给「已知选项直接命中、没建过的才补建」那条分岔用 */
const selectOptions = (...names: { name: string; id: string }[]) =>
  JSON.stringify({ kind: "select", options: names.map((o) => ({ ...o, color: "gray" })) });

const viewOf = (name: string): View => ({
  id: "v-grid",
  workspace_id: "ws-1",
  parent_id: null,
  name,
  icon: null,
  layout: "grid",
  extra: "{}",
  position: 0,
  is_favorite: 0,
  is_trash: 0,
  deleted_at: null,
  created_at: 0,
  updated_at: 0,
  visited_at: null,
  source_id: null,
  tags: "[]",
  aliases: "[]",
});

/**
 * 造切片：默认「文本 + 数字两列、两行、没有编辑中、没有粘贴锚点、无导入计划」。
 * store 只用得到三个动作，storeApi 只用得到 getState().fields（补建选项后下一格要读最新定义），
 * 所以这里给的是窄假对象；DatabaseState / DatabaseStore 的真实形状由 store 自己的用例钉，不在这里重言。
 */
function build(over: Partial<SliceCtx> = {}) {
  const fields = over.fields ?? [
    field("f-name", "名称", "text", { position: 0 }),
    field("f-num", "数量", "number", { position: 1 }),
  ];
  const store = {
    fields,
    addRows: h.addRows,
    setCellsMany: h.setCellsMany,
    addSelectOption: h.addSelectOption,
  } as unknown as DatabaseState;
  const storeApi = { getState: () => ({ fields }) } as unknown as DatabaseStore;
  return createGridIoSlice({
    source: viewOf("客户"),
    fields,
    cells: {},
    displayRows: [row("r-1", 0), row("r-2", 1)],
    displayCells: {},
    relationDbOf: () => undefined,
    visibleFields: fields,
    editing: null,
    pasteAnchorRef: { current: null as { rowId: string; fieldId: string } | null },
    store,
    storeApi,
    importPlan: null,
    setImportPlan: vi.fn(),
    ...over,
  });
}

const planOf = (over: Partial<GridImportPlan> = {}): GridImportPlan => ({
  fileName: "订单",
  headers: ["名称", "数量"],
  types: ["text", "number"],
  dataRows: [
    ["甲", "3"],
    ["乙", "4"],
  ],
  ...over,
});

/**
 * 手搓一个 paste 事件：只挂 handler 真正读的三张口（target / clipboardData / preventDefault）。
 * 两个句柄跟着事件一起交回去——断言写成 `evt.preventDefault` 会被 lint 判成未绑定的方法引用。
 */
function pasteEvt(text: string, target: HTMLElement = document.createElement("div")) {
  const getData = vi.fn((kind: string) => (kind === "text/plain" ? text : ""));
  const preventDefault = vi.fn();
  const evt = {
    target,
    clipboardData: { getData },
    preventDefault,
    currentTarget: target,
  } as unknown as React.ClipboardEvent<HTMLElement>;
  return { evt, getData, preventDefault };
}

/** 取某条命令第 n 次调用的第一组参数 */
const argsOf = (cmd: string, nth = 0) =>
  h.calls.filter((c) => c.cmd === cmd)[nth]?.args?.[0] as Record<string, unknown> | undefined;

/** setCellsMany 收到的那片更新 */
const writtenCells = (nth = 0) =>
  (h.setCellsMany.mock.calls[nth]?.[0] ?? []) as { rowId: string; fieldId: string; value: CellValue }[];

beforeEach(() => {
  vi.clearAllMocks();
  h.handlers.clear();
  h.calls.length = 0;
  h.ws.currentWorkspaceId = "ws-1";
  h.ws.reloaded = 0;
  h.ws.opened.length = 0;
  let seq = 0;
  h.invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    h.calls.push({ cmd, args: args === undefined ? [] : [args] });
    if (!h.handlers.has(cmd)) return Promise.reject(new Error(`用例没登记命令 ${cmd}`));
    const value = h.handlers.get(cmd);
    if (value instanceof Error) return Promise.reject(value);
    return Promise.resolve(typeof value === "function" ? value(args) : value);
  });
  h.save.mockImplementation(() => Promise.resolve("D:/out.csv"));
  h.open.mockImplementation(() => Promise.resolve("D:/data/订单.csv"));
  // 默认「一行也没建出来」：要用到建行结果的用例自己覆盖，否则漏覆盖会悄悄少写一格
  h.addRows.mockImplementation(() => Promise.resolve([] as DatabaseRow[]));
  h.setCellsMany.mockImplementation(() => Promise.resolve());
  h.addSelectOption.mockImplementation(() => Promise.resolve(null));
  h.viewCreate.mockImplementation(() => Promise.resolve({ id: "v-new" }));
  h.newId.mockImplementation(() => `gen-${(seq += 1)}`);
});

describe("导出的两道取消与两种失败", () => {
  it("CSV 导出：在保存对话框上取消，就不写文件也不出声", async () => {
    h.save.mockResolvedValue(null);
    await build().exportCsv();
    expect(h.save).toHaveBeenCalledTimes(1);
    expect(h.calls.some((c) => c.cmd === "write_text_file")).toBe(false);
    expect(h.toastSuccess).not.toHaveBeenCalled();
    expect(h.toastError).not.toHaveBeenCalled();
  });

  it("CSV 导出：写盘失败只报现象，不再补一句「已导出」", async () => {
    h.handlers.set("write_text_file", new Error("磁盘满了"));
    await build().exportCsv();
    expect(h.loggerError).toHaveBeenCalledWith("csv export failed", new Error("磁盘满了"));
    expect(h.toastError).toHaveBeenCalledWith('error.csv:{"message":"Error: 磁盘满了"}');
    expect(h.toastSuccess).not.toHaveBeenCalled();
  });

  it("xlsx 导出：宿主没有标题时，表名与默认文件名一起退成 export", async () => {
    h.save.mockResolvedValue("D:/out.xlsx");
    h.handlers.set("export_xlsx", undefined);
    await build({ source: viewOf("") }).exportXlsx();
    expect(h.save.mock.calls[0]?.[0]?.defaultPath).toBe("export.xlsx");
    expect(argsOf("export_xlsx")).toMatchObject({ path: "D:/out.xlsx", sheet: { name: "export" } });
  });

  it("xlsx 导出：取消就不打命令；命令失败走 xlsx 自己的错误文案", async () => {
    h.save.mockResolvedValue(null);
    await build().exportXlsx();
    expect(h.calls.some((c) => c.cmd === "export_xlsx")).toBe(false);

    h.save.mockResolvedValue("D:/out.xlsx");
    h.handlers.set("export_xlsx", new Error("打包失败"));
    await build().exportXlsx();
    expect(h.toastError).toHaveBeenCalledWith('error.xlsx:{"message":"Error: 打包失败"}');
    expect(h.loggerError).toHaveBeenCalledWith("xlsx export failed", new Error("打包失败"));
    expect(h.toastSuccess).not.toHaveBeenCalled();
  });
});

describe("粘贴前的六道闸门", () => {
  const tsv = "1\t甲\n2\t乙";

  it("正在编辑单元格时整段不接管：连剪贴板都不读", async () => {
    const { evt, getData, preventDefault } = pasteEvt(tsv);
    const { onPasteTsv } = build({
      editing: { rowId: "r-1", fieldId: "f-name" },
      pasteAnchorRef: { current: { rowId: "r-1", fieldId: "f-name" } },
    });
    await onPasteTsv(evt);
    expect(getData).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(h.addRows).not.toHaveBeenCalled();
  });

  it("粘贴目标在输入框里也不接管（编辑框自己的单格粘贴归浏览器）", async () => {
    const { onPasteTsv } = build({ pasteAnchorRef: { current: { rowId: "r-1", fieldId: "f-name" } } });
    await onPasteTsv(pasteEvt(tsv, document.createElement("textarea")).evt);
    expect(h.addRows).not.toHaveBeenCalled();
    expect(h.setCellsMany).not.toHaveBeenCalled();
  });

  it("一段既无制表符也无换行的文本不算表格：不接管，也不提示「没有锚点」", async () => {
    const { evt, preventDefault } = pasteEvt("就一个数");
    await build({ pasteAnchorRef: { current: { rowId: "r-1", fieldId: "f-name" } } }).onPasteTsv(evt);
    expect(h.toastInfo).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("没点过任何格子时出声提示，但不拦默认粘贴（否则用户连单格文本都贴不进去）", async () => {
    const { evt, preventDefault } = pasteEvt(tsv);
    await build({ pasteAnchorRef: { current: null } }).onPasteTsv(evt);
    expect(h.toastInfo).toHaveBeenCalledWith("csv.pasteNoAnchor");
    expect(preventDefault).not.toHaveBeenCalled();
    expect(h.addRows).not.toHaveBeenCalled();
  });

  it("锚点指向的行或列已不在这一份快照里：静默收手，一行都不建", async () => {
    const { evt, preventDefault } = pasteEvt(tsv);
    await build({ pasteAnchorRef: { current: { rowId: "r-9", fieldId: "f-name" } } }).onPasteTsv(evt);
    // 拦是拦下了（preventDefault 在建行之前），但没有任何写入，也不出声
    expect(preventDefault).toHaveBeenCalled();
    expect(h.addRows).not.toHaveBeenCalled();
    expect(h.setCellsMany).not.toHaveBeenCalled();
    expect(h.toastSuccess).not.toHaveBeenCalled();
  });

  it("要补的行没建够：整片放弃，不写半张贴进去", async () => {
    const { evt } = pasteEvt("1\t甲\n2\t乙\n3\t丙");
    const { onPasteTsv } = build({ pasteAnchorRef: { current: { rowId: "r-1", fieldId: "f-name" } } });
    // 三行数据落在只有两行的表上：要补 1 行，而默认的 addRows 替身交回空数组
    await onPasteTsv(evt);
    expect(h.addRows).toHaveBeenCalledWith(1);
    expect(h.setCellsMany).not.toHaveBeenCalled();
    expect(h.toastSuccess).not.toHaveBeenCalled();
    expect(h.toastWarning).not.toHaveBeenCalled();
  });

  it("粘贴途中写库失败：记日志并报现象，不出「已粘贴」", async () => {
    h.addRows.mockResolvedValue([row("r-3", 2)]);
    h.setCellsMany.mockRejectedValue(new Error("库锁住了"));
    await build({ pasteAnchorRef: { current: { rowId: "r-1", fieldId: "f-name" } } }).onPasteTsv(
      pasteEvt("1\t甲\n2\t乙\n3\t丙").evt,
    );
    expect(h.loggerError).toHaveBeenCalledWith("tsv paste failed", new Error("库锁住了"));
    expect(h.toastError).toHaveBeenCalledWith('error.csv:{"message":"Error: 库锁住了"}');
    expect(h.toastSuccess).not.toHaveBeenCalled();
  });
});

describe("粘贴的 skipped 分三档计数", () => {
  it("超出最右可见列的那些格：写进可见列，多出来的列计入跳过", async () => {
    await build({ pasteAnchorRef: { current: { rowId: "r-1", fieldId: "f-name" } } }).onPasteTsv(
      pasteEvt("甲\t1\t多余\n乙\t2\t多余").evt,
    );
    expect(writtenCells().map((u) => [u.rowId, u.fieldId, u.value])).toEqual([
      ["r-1", "f-name", "甲"],
      ["r-1", "f-num", 1],
      ["r-2", "f-name", "乙"],
      ["r-2", "f-num", 2],
    ]);
    expect(h.toastSuccess).toHaveBeenCalledWith('csv.pasted:{"n":"4"}');
    expect(h.toastWarning).toHaveBeenCalledWith('csv.pasteSkipped:{"n":"2"}');
  });

  it("只读列给不出合法值：那一格不进 updates，另一列照写", async () => {
    const fields = [field("f-name", "名称", "text"), field("f-cal", "算出来的", "formula")];
    await build({
      fields,
      visibleFields: fields,
      pasteAnchorRef: { current: { rowId: "r-1", fieldId: "f-name" } },
    }).onPasteTsv(pasteEvt("甲\t9\n乙\t8").evt);
    expect(writtenCells().map((u) => u.fieldId)).toEqual(["f-name", "f-name"]);
    expect(h.toastWarning).toHaveBeenCalledWith('csv.pasteSkipped:{"n":"2"}');
  });

  it("选择列补建失败：这格仍写出去（已知的部分留着），但计入跳过", async () => {
    const fields = [
      field("f-name", "名称", "text"),
      field("f-tag", "标签", "single_select", { options: selectOptions({ name: "已知", id: "o-1" }) }),
    ];
    h.addSelectOption.mockResolvedValue(null);
    await build({
      fields,
      visibleFields: fields,
      pasteAnchorRef: { current: { rowId: "r-1", fieldId: "f-tag" } },
    }).onPasteTsv(pasteEvt("没建过\n已知").evt);
    const updates = writtenCells();
    // 第一行「没建过」补建失败 → 值只剩 null（一个可用 id 都没凑出来），但没建过的那格不撤回
    expect(updates.map((u) => [u.rowId, u.value])).toEqual([
      ["r-1", null],
      ["r-2", "o-1"],
    ]);
    expect(h.addSelectOption).toHaveBeenCalledWith("f-tag", "没建过");
    expect(h.toastSuccess).toHaveBeenCalledWith('csv.pasted:{"n":"2"}');
    expect(h.toastWarning).toHaveBeenCalledWith('csv.pasteSkipped:{"n":"1"}');
  });

  it("整片一个格都没写成：只报跳过，不出「已粘贴 0 个单元格」", async () => {
    // 两列都是「一段文本给不出合法值」的类型（公式只读、关联要选行），粘贴框里贴什么都不可能落库
    const fields = [field("f-cal", "算", "formula"), field("f-rel", "关系", "relation")];
    await build({
      fields,
      visibleFields: fields,
      pasteAnchorRef: { current: { rowId: "r-1", fieldId: "f-cal" } },
    }).onPasteTsv(pasteEvt("甲\n乙").evt);
    expect(h.setCellsMany).toHaveBeenCalledWith([]);
    expect(h.toastSuccess).not.toHaveBeenCalled();
    expect(h.toastWarning).toHaveBeenCalledWith('csv.pasteSkipped:{"n":"2"}');
  });
});

describe("CSV 导入入口的分支", () => {
  it("在文件选择框上取消，或拿到的不是单个字符串，都不往下读", async () => {
    h.open.mockResolvedValue(null);
    await build().importCsv();
    expect(h.calls.some((c) => c.cmd === "read_text_file")).toBe(false);

    h.open.mockResolvedValue(["D:/a.csv", "D:/b.csv"]);
    const setImportPlan = vi.fn();
    await build({ setImportPlan }).importCsv();
    expect(setImportPlan).not.toHaveBeenCalled();
    expect(h.toastError).not.toHaveBeenCalled();
  });

  it("解析完一行都不剩的文件：报「空文件」，不设计划", async () => {
    h.handlers.set("read_text_file", () => "");
    const setImportPlan = vi.fn();
    await build({ setImportPlan }).importCsv();
    expect(h.toastError).toHaveBeenCalledWith("csv.emptyFile");
    expect(setImportPlan).not.toHaveBeenCalled();
  });

  it("新表名取文件名去掉扩展：正反斜杠、大写 .CSV 都算；取不出名字才退默认名", async () => {
    h.handlers.set("read_text_file", () => "名称,数量\n甲,3");
    const setImportPlan = vi.fn();
    const slice = build({ setImportPlan });

    h.open.mockResolvedValue("D:/data/订单.CSV");
    await slice.importCsv();
    expect(setImportPlan.mock.calls[0]?.[0]).toMatchObject({ fileName: "订单", headers: ["名称", "数量"] });

    setImportPlan.mockClear();
    h.open.mockResolvedValue("C:\\data\\月报.csv");
    await slice.importCsv();
    expect(setImportPlan.mock.calls[0]?.[0]).toMatchObject({ fileName: "月报" });

    setImportPlan.mockClear();
    h.open.mockResolvedValue("/.csv");
    await slice.importCsv();
    expect(setImportPlan.mock.calls[0]?.[0]).toMatchObject({ fileName: "csv.importDefaultName" });
  });

  it("读文件失败：记日志并报现象，不设计划", async () => {
    h.handlers.set("read_text_file", new Error("没权限"));
    const setImportPlan = vi.fn();
    await build({ setImportPlan }).importCsv();
    expect(h.loggerError).toHaveBeenCalledWith("csv import failed", new Error("没权限"));
    expect(h.toastError).toHaveBeenCalledWith('error.csv:{"message":"Error: 没权限"}');
    expect(setImportPlan).not.toHaveBeenCalled();
  });
});

describe("确认类型后建新表", () => {
  it("计划已经被清掉：仍先把计划置空，然后一个字段都不建", async () => {
    const setImportPlan = vi.fn();
    await build({ importPlan: null, setImportPlan }).runImportCsv(["text"], {}, "new");
    expect(setImportPlan).toHaveBeenCalledWith(null);
    expect(h.viewCreate).not.toHaveBeenCalled();
    expect(h.calls.some((c) => c.cmd === "csv_import")).toBe(false);
  });

  it("没有当前工作区：不建视图，但计划照样清掉", async () => {
    h.ws.currentWorkspaceId = null;
    const setImportPlan = vi.fn();
    await build({ importPlan: planOf(), setImportPlan }).runImportCsv(["text", "number"], {}, "new");
    expect(setImportPlan).toHaveBeenCalledWith(null);
    expect(h.viewCreate).not.toHaveBeenCalled();
  });

  it("同名表头按序号消歧，第三列撞的是刚改出来的那个名", async () => {
    h.handlers.set("csv_import", undefined);
    const plan = planOf({
      headers: ["名称", "名称", "名称"],
      dataRows: [["a", "b", "c"]],
    });
    await build({ importPlan: plan }).runImportCsv(["text", "text", "text"], {}, "new");
    const fields = argsOf("csv_import")?.fields as { name: string }[];
    expect(fields.map((f) => f.name)).toEqual(["名称", "名称 2", "名称 2 2"]);
  });

  it("选择列按整列的值建选项，单元格存选项 id；空值与给不出值的列都不进载荷", async () => {
    h.handlers.set("csv_import", undefined);
    const plan = planOf({
      headers: ["标签", "数量", "备注"],
      types: ["single_select", "number", "text"],
      dataRows: [
        ["重要", "3", ""],
        ["普通", "不数字", "留着"],
      ],
    });
    await build({ importPlan: plan }).runImportCsv(["single_select", "number", "text"], {}, "new");
    const payload = argsOf("csv_import")!;
    const fields = payload.fields as { id: string; name: string; field_type: string; options: string | null }[];
    expect(fields.map((f) => [f.name, f.field_type])).toEqual([
      ["标签", "single_select"],
      ["数量", "number"],
      ["备注", "text"],
    ]);
    // 选择列的 options 把整列出现过的名字都建了出来（单元格的 id 要能在里面查到）
    const opts = JSON.parse(String(fields[0].options)) as { kind: string; options: { name: string; id: string }[] };
    expect(opts.kind).toBe("select");
    expect(opts.options.map((o) => o.name)).toEqual(["重要", "普通"]);
    const idOf = (name: string) => opts.options.find((o) => o.name === name)?.id;
    const nameOf = (fieldId: string) => fields.find((f) => f.id === fieldId)?.name;
    const cellsOf = (rowIndex: number) =>
      (payload.rows as { cells: { field_id: string; value: string }[] }[])[rowIndex].cells.map((c) => [
        nameOf(c.field_id),
        JSON.parse(c.value) as CellValue,
      ]);
    // 备注列第一行是空 → 整格不进载荷；数量列的「不数字」给不出数 → 也不进
    expect(cellsOf(0)).toEqual([
      ["标签", idOf("重要")],
      ["数量", 3],
    ]);
    expect(cellsOf(1)).toEqual([
      ["标签", idOf("普通")],
      ["备注", "留着"],
    ]);
    // 非选择列不带 options（建表时写 null，交给 Rust 侧默认）
    expect(fields[1].options).toBeNull();
  });

  it("多选列的整格空白连「空数组」都不写：那格不进载荷", async () => {
    // 这条是为了追 M23（把「整格空白就跳过」的守卫删掉）而写的，结果删掉照样绿：
    // 空白在选项列走 selectCellToIds（一个名字都没有 → null），在其余类型走各 kind 的 paste（空文本 → 按空处理），
    // 下面那条 `cell !== null` 已经把空白挡掉了——建新表这一路的空白守卫是冗余守卫。
    // 追加那一路的同一条守卫（M31）就删不得：它走的是 pasteCell，返回的是「值为 null 的对象」而不是 null。
    h.handlers.set("csv_import", undefined);
    const plan = planOf({
      headers: ["标签", "备注"],
      types: ["multi_select", "text"],
      dataRows: [
        ["甲; 乙", "写了"],
        ["", "也写了"],
      ],
    });
    await build({ importPlan: plan }).runImportCsv(["multi_select", "text"], {}, "new");
    const payload = argsOf("csv_import")!;
    const fields = payload.fields as { id: string; name: string }[];
    const nameOf = (fieldId: string) => fields.find((f) => f.id === fieldId)!.name;
    const cellNames = (rowIndex: number) =>
      (payload.rows as { cells: { field_id: string }[] }[])[rowIndex].cells.map((c) => nameOf(c.field_id));
    expect(cellNames(0)).toEqual(["标签", "备注"]);
    expect(cellNames(1)).toEqual(["备注"]);
  });

  it("附件列：每个源路径各复制一次，复制失败与没匹配上的名字合起来报一次", async () => {
    let saved = 0;
    h.handlers.set("csv_import", undefined);
    h.handlers.set("save_asset", (args) => {
      const p = String((args as { sourcePath: string }).sourcePath);
      if (p.endsWith("坏.png")) throw new Error("复制失败");
      saved += 1;
      return `assets/${saved}.png`;
    });
    const plan = planOf({
      headers: ["名称", "图"],
      types: ["text", "attachment"],
      dataRows: [
        ["甲", "好.png; 好.png; 没这个.png"],
        ["乙", "坏.png"],
      ],
    });
    await build({ importPlan: plan }).runImportCsv(
      ["text", "attachment"],
      { 1: { "好.png": "D:/img/好.png", "坏.png": "D:/img/坏.png" } },
      "new",
    );
    // 同名候选只算一次：两份额外的「好.png」不重复复制，加上另一个名字与另一行的坏文件，一共两次
    expect(h.calls.filter((c) => c.cmd === "save_asset")).toHaveLength(2);
    const payload = argsOf("csv_import")!;
    const fields = payload.fields as { id: string; name: string }[];
    const imgId = fields.find((f) => f.name === "图")?.id;
    const rows = payload.rows as { cells: { field_id: string; value: string }[] }[];
    const imgCell = rows[0].cells.find((c) => c.field_id === imgId);
    expect(imgCell && JSON.parse(imgCell.value)).toEqual([{ name: "好.png", path: "assets/1.png" }]);
    // 「坏.png」复制失败：一个 ref 都没凑出来 → 这一格干脆不写
    expect(rows[1].cells.find((c) => c.field_id === imgId)).toBeUndefined();
    expect(h.toastWarning).toHaveBeenCalledWith('csv.attachment.missingToast:{"n":"2","names":"没这个.png, 坏.png"}');
  });

  it("缺的附件名超过五个只列前五个并折叠；成功那句按数据行数报", async () => {
    h.handlers.set("csv_import", undefined);
    h.handlers.set("save_asset", () => "assets/x.png");
    const plan = planOf({
      headers: ["图"],
      types: ["attachment"],
      dataRows: [["a; b; c; d; e; f"], ["x.png"]],
    });
    await build({ importPlan: plan }).runImportCsv(["attachment"], { 0: { "x.png": "D:/x.png" } }, "new");
    expect(h.toastWarning).toHaveBeenCalledWith('csv.attachment.missingToast:{"n":"6","names":"a, b, c, d, e …(+1)"}');
    expect(h.toastSuccess).toHaveBeenCalledWith('csv.imported:{"count":"2"}');
  });

  it("建新表成功后先刷新工作区再跳过去；落库失败就不跳", async () => {
    h.handlers.set("csv_import", undefined);
    await build({ importPlan: planOf() }).runImportCsv(["text", "number"], {}, "new");
    expect(h.ws.reloaded).toBe(1);
    expect(h.ws.opened).toEqual(["v-new"]);
    expect(h.toastSuccess).toHaveBeenCalledWith('csv.imported:{"count":"2"}');

    h.ws.reloaded = 0;
    h.ws.opened.length = 0;
    h.handlers.set("csv_import", new Error("库锁住了"));
    await build({ importPlan: planOf() }).runImportCsv(["text", "number"], {}, "new");
    expect(h.toastError).toHaveBeenCalledWith('error.csv:{"message":"Error: 库锁住了"}');
    expect(h.ws.reloaded).toBe(0);
    expect(h.ws.opened).toEqual([]);
  });

  it("选了「追加到当前表」就不建新视图：改走建行 + 批量写格", async () => {
    h.addRows.mockResolvedValue([row("r-9", 9), row("r-10", 10)]);
    await build({ importPlan: planOf() }).runImportCsv(["text", "number"], {}, "current");
    expect(h.viewCreate).not.toHaveBeenCalled();
    expect(h.calls.some((c) => c.cmd === "csv_import")).toBe(false);
    expect(writtenCells().map((u) => [u.rowId, u.fieldId])).toEqual([
      ["r-9", "f-name"],
      ["r-9", "f-num"],
      ["r-10", "f-name"],
      ["r-10", "f-num"],
    ]);
  });
});

describe("追加到当前表", () => {
  it("一列都对不上现有字段：报「没匹配」，一行都不建", async () => {
    await build({ importPlan: planOf({ headers: ["对不上", "也不对"] }) }).runImportCsv(
      ["text", "text"],
      {},
      "current",
    );
    expect(h.toastError).toHaveBeenCalledWith("csv.appendNoMatch");
    expect(h.addRows).not.toHaveBeenCalled();
    expect(h.setCellsMany).not.toHaveBeenCalled();
  });

  it("列名忽略大小写与首尾空白；只读列与关联列算进跳过的列", async () => {
    h.addRows.mockResolvedValue([row("r-9", 9)]);
    const fields = [
      field("f-name", " 名称 ", "text"),
      field("f-cal", "算", "formula"),
      field("f-rel", "关系", "relation"),
    ];
    await build({
      fields,
      visibleFields: fields,
      importPlan: planOf({
        headers: ["名称", "算", "关系"],
        types: ["text", "formula", "relation"],
        dataRows: [["甲", "1", "r-1"]],
      }),
    }).runImportCsv(["text", "formula", "relation"], {}, "current");
    expect(writtenCells().map((u) => [u.fieldId, u.value])).toEqual([["f-name", "甲"]]);
    expect(h.toastWarning).toHaveBeenCalledWith('csv.appendSkippedCols:{"n":"2"}');
  });

  it("建行少给了一行：缺的那行跳过，出声的行数按真正建出来的报", async () => {
    h.addRows.mockResolvedValue([row("r-9", 9)]);
    await build({ importPlan: planOf() }).runImportCsv(["text", "number"], {}, "current");
    expect(writtenCells().map((u) => u.rowId)).toEqual(["r-9", "r-9"]);
    expect(h.toastSuccess).toHaveBeenCalledWith('csv.appended:{"count":"1"}');
  });

  it("空白值不写；附件列复制失败的名字进缺名提示，那一格不写", async () => {
    h.addRows.mockResolvedValue([row("r-9", 9), row("r-10", 10)]);
    h.handlers.set("save_asset", new Error("复制失败"));
    const fields = [field("f-name", "名称", "text"), field("f-img", "图", "attachment")];
    await build({
      fields,
      visibleFields: fields,
      importPlan: planOf({
        headers: ["名称", "图"],
        types: ["text", "attachment"],
        dataRows: [
          ["  ", "图一.png"],
          ["乙", ""],
        ],
      }),
    }).runImportCsv(["text", "attachment"], { 1: { "图一.png": "D:/img/图一.png" } }, "current");
    // 第一行名称是空白 → 不写；图列复制失败 → 一个 ref 都没有 → 也不写；第二行只写名称
    expect(writtenCells().map((u) => [u.fieldId, u.value])).toEqual([["f-name", "乙"]]);
    expect(h.toastWarning).toHaveBeenCalledWith('csv.attachment.missingToast:{"n":"1","names":"图一.png"}');
  });

  it("追加过程出错：记日志报现象，不出「已追加」", async () => {
    h.addRows.mockRejectedValue(new Error("库锁住了"));
    await build({ importPlan: planOf() }).runImportCsv(["text", "number"], {}, "current");
    expect(h.loggerError).toHaveBeenCalledWith("csv append failed", new Error("库锁住了"));
    expect(h.toastError).toHaveBeenCalledWith('error.csv:{"message":"Error: 库锁住了"}');
    expect(h.toastSuccess).not.toHaveBeenCalled();
  });
});
