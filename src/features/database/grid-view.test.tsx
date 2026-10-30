// @vitest-environment jsdom
// CSV 导入的贯穿用例：选文件 → 解析 → 弹类型确认 → 建表落库。
// 这一条链原先只有头（CsvImportDialog 的附件选择）和尾（csv.ts 的解析与类型推断）各自单测，
// 中间的接线（谁把 open() 的结果喂给 read_text_file、确认后调哪条命令）没有覆盖过。
// 现在整条链都在替身上跑：对话框与命令都从 @/lib/ipc-dialog / ipc-core 进来，断言落在命令参数上。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { GridView } from "./GridView";
import { resetStores } from "@/test/store-reset";
import {
  callsFor,
  dialogCalls,
  queueOpenDialog,
  queueSaveDialog,
  resetIpcMock,
  setIpcHandlers,
} from "@/test/tauri-mock";
import type { View } from "@/types/models";

vi.mock("@/lib/ipc/ipc-core", async () => (await import("@/test/tauri-mock")).ipcCoreMock());
vi.mock("@/lib/ipc/ipc-dialog", async () => (await import("@/test/tauri-mock")).ipcDialogMock());
vi.mock("@/lib/ipc/ipc-fs", async () => (await import("@/test/tauri-mock")).ipcFsMock());

const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
const toastWarning = vi.hoisted(() => vi.fn());
const toastInfo = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({
  toast: { success: toastSuccess, error: toastError, warning: toastWarning, info: toastInfo },
}));

// 工作区侧只用来取当前空间并在导入后跳页，替身把这两件事记下来即可
const ws = vi.hoisted(() => ({ currentWorkspaceId: "ws-1", reloaded: 0, opened: [] as string[] }));
vi.mock("@/stores/workspace", async () => {
  const { create } = await import("zustand");
  const store = create(() => ({
    currentWorkspaceId: ws.currentWorkspaceId,
    reload: () => {
      ws.reloaded += 1;
      return Promise.resolve();
    },
    openView: (id: string) => {
      ws.opened.push(id);
    },
  }));
  // 真 store 既能当 hook 用（带 selector），也有 getState()：zustand 的 create 本来就两者都给
  return { useWorkspaceStore: store };
});

class FakeResizeObserver {
  observe(): void {
    /* jsdom 量不出尺寸：网格的窗口化切片在这里退化成「全渲染」，正是我们要断言的东西 */
  }
  unobserve(): void {
    /* 同上 */
  }
  disconnect(): void {
    /* 同上 */
  }
}
globalThis.ResizeObserver = FakeResizeObserver;

// jsdom 没实现 scrollIntoView：光标落定后网格要把目标格滚进视口（GridView.tsx 的那重试帧效果），
// 粘贴用例要先把光标落到某格，这里按空操作补上——滚动本身不是这条链要验的东西
Element.prototype.scrollIntoView = () => {
  /* 没有可滚的视口，也没什么可断言的 */
};

const view: View = {
  id: "v-grid",
  workspace_id: "ws-1",
  parent_id: null,
  name: "客户",
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
};

beforeEach(() => {
  cleanup();
  resetIpcMock();
  // 数据 store 是模块级单例（Context 的默认值），上一条留下的 fields 会让本条渲染出旧列：整份复位
  resetStores();
  toastSuccess.mockReset();
  toastWarning.mockReset();
  toastInfo.mockReset();
  ws.currentWorkspaceId = "ws-1";
  ws.reloaded = 0;
  ws.opened.length = 0;
  setIpcHandlers({
    field_list: () => [],
    row_list: () => [],
    cells_load: () => [],
    read_text_file: () => "名称,数量\n甲,3\n乙,4\n",
    view_create: (args) => ({ ...view, id: "v-new", name: String(args?.name) }),
    csv_import: () => undefined,
  });
});

// 夹具：三条用例都靠 field_list / row_list / cells_load 喂切片要的注入值，只有行列数量与格值不同
const fieldOf = (id: string, name: string, fieldType: string, position: number) => ({
  id,
  database_view_id: "v-grid",
  name,
  field_type: fieldType,
  width: 160,
  is_hidden: 0,
  position,
});
const rowOf = (id: string, position: number) => ({
  id,
  database_view_id: "v-grid",
  position,
  document_id: null,
  parent_id: null,
  created_at: 0,
  updated_at: 0,
});
/** 两字段（名称 text / 数量 number）两行，只有 r-1 的名称写过「甲」：导出与追加共用这份快照 */
const twoByTwo = () => ({
  field_list: () => [fieldOf("f-name", "名称", "text", 0), fieldOf("f-num", "数量", "number", 1)],
  row_list: () => [rowOf("r-1", 0), rowOf("r-2", 1)],
  cells_load: () => [{ row_id: "r-1", field_id: "f-name", value: JSON.stringify("甲") }],
});
/** row_create_many 按前端生成的 id 出脚（与 Rust 侧同形）：断言写入时才对得上新行号 */
const echoCreatedRows = (args?: Record<string, unknown>) =>
  ((args?.ids as string[] | undefined) ?? []).map((id, i) => rowOf(id, 90 + i));
/** cell_set_many 的落库参数（snake_case 嵌套 payload），取出来逐格断言 */
const cellWrites = () =>
  (callsFor("cell_set_many")[0]?.args?.updates as { row_id: string; field_id: string; value: string }[] | undefined) ??
  [];

describe("GridView 的 CSV 导入入口", () => {
  it("选完文件弹出类型确认，确认后按文件名建表并打 csv_import", async () => {
    const user = userEvent.setup();
    queueOpenDialog("D:/data/订单.csv");
    render(<GridView view={view} source={view} />);

    await user.click(await screen.findByRole("button", { name: "导入" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("确认导入字段类型")).toBeTruthy();

    await user.click(within(dialog).getByRole("button", { name: "导入" }));

    await waitFor(() => expect(callsFor("csv_import")).toHaveLength(1));
    expect(toastError).not.toHaveBeenCalled();
    const created = callsFor("view_create")[0].args;
    expect(created).toMatchObject({ name: "订单", layout: "grid", workspaceId: "ws-1" });

    const payload = callsFor("csv_import")[0].args;
    expect(payload?.viewId).toBe("v-new");
    const fields = payload?.fields as { name: string; field_type: string }[];
    expect(fields.map((f) => [f.name, f.field_type])).toEqual([
      ["名称", "text"],
      ["数量", "number"],
    ]);
    expect(payload?.rows).toHaveLength(2);
    expect(ws.reloaded).toBe(1);
    expect(ws.opened).toEqual(["v-new"]);
    expect(toastSuccess).toHaveBeenCalledWith("已导入 2 行");
  });

  it("对话框上取消：不建表也不落库", async () => {
    const user = userEvent.setup();
    queueOpenDialog("D:/data/订单.csv");
    render(<GridView view={view} source={view} />);

    await user.click(await screen.findByRole("button", { name: "导入" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "取消" }));

    expect(callsFor("view_create")).toHaveLength(0);
    expect(callsFor("csv_import")).toHaveLength(0);
  });
});

// 导出这条链原先零覆盖：切片搬走后它靠 13 个注入值喂数据，这里钉住「行列单元格真到了导出函数里」
describe("GridView 的导出入口", () => {
  it("导出 CSV：可见行列折成文本，文件名取宿主页面标题", async () => {
    const user = userEvent.setup();
    setIpcHandlers({ ...twoByTwo(), write_text_file: () => undefined });
    queueSaveDialog("D:/out/客户.csv");
    render(<GridView view={view} source={view} />);

    await user.click(await screen.findByRole("button", { name: "导出 CSV" }));

    await waitFor(() => expect(callsFor("write_text_file")).toHaveLength(1));
    const args = callsFor("write_text_file")[0].args;
    // 前置 BOM + 表头 + 两行数据（第二行没写过值，仍按空行带出）
    const content = String(args?.content);
    expect(content.charCodeAt(0)).toBe(0xfeff); // 前置 BOM：Excel 才不会把中文显示成乱码
    // 表头 + 两行都带出（第二行没写过值，是一行空逗号）：可见行列真到了导出函数里
    expect(content.slice(1).split(/\r?\n/).slice(0, 3)).toEqual(["名称,数量", "甲,", ","]);
    // 存盘路径来自 save 对话框，默认名由宿主标题 + 扩展名拼出
    expect(args?.path).toBe("D:/out/客户.csv");
    expect(dialogCalls[dialogCalls.length - 1]?.options?.defaultPath).toBe("客户.csv");
    expect(toastSuccess).toHaveBeenCalledWith("已导出 CSV");
  });

  it("导出 xlsx：列种类与单元格值交给 Rust 的 export_xlsx，空格写成 null", async () => {
    const user = userEvent.setup();
    setIpcHandlers({ ...twoByTwo(), export_xlsx: () => undefined });
    queueSaveDialog("D:/out/客户.xlsx");
    render(<GridView view={view} source={view} />);

    await user.click(await screen.findByRole("button", { name: "导出 xlsx" }));

    await waitFor(() => expect(callsFor("export_xlsx")).toHaveLength(1));
    const args = callsFor("export_xlsx")[0].args;
    expect(args?.path).toBe("D:/out/客户.xlsx");
    expect(dialogCalls[dialogCalls.length - 1]?.options?.defaultPath).toBe("客户.xlsx");
    // 工作簿载荷：表名取宿主标题，列带类型（text / number 决定 Rust 侧写成数值还是文本），
    // 没写过的格是 null（不是空串，否则导出会多出满屏的空字符串单元格）
    const sheet = args?.sheet as {
      name: string;
      columns: { header: string; kind: string }[];
      rows: (string | number | null)[][];
    };
    expect(sheet.name).toBe("客户");
    expect(sheet.columns).toEqual([
      { header: "名称", kind: "text" },
      { header: "数量", kind: "number" },
    ]);
    expect(sheet.rows).toEqual([
      ["甲", null],
      [null, null],
    ]);
    expect(toastSuccess).toHaveBeenCalledWith("已导出 xlsx");
  });
});

// 粘贴与追加这两条链此前零覆盖：它们都从同一批注入值取数，但写入完全走 store（一次建行 + 一次批量写格），
// 所以断言落在「发给 Rust 的参数」上，而不是只看有没有出声。
describe("GridView 的 TSV 粘贴", () => {
  it("从点过的格子向右向下展开，行数不够先一次建行补齐", async () => {
    const user = userEvent.setup();
    setIpcHandlers({
      field_list: () => [
        fieldOf("f-name", "名称", "text", 0),
        fieldOf("f-num", "数量", "number", 1),
        fieldOf("f-note", "备注", "text", 2),
      ],
      row_list: () => [rowOf("r-1", 0), rowOf("r-2", 1)],
      cells_load: () => [],
      row_create_many: echoCreatedRows,
      cell_set_many: () => 6,
    });
    render(<GridView view={view} source={view} />);

    // 锚点是 r-1 的「数量」格：单击即开编辑框（本仓取态），所以点完按一下 Esc 收手——
    // 光标与粘贴锚点留下，editing 清空（编辑中的粘贴按设计走单格默认行为，不归网格接管）
    // 等到第三列也渲染出来再点：闭包里的 visibleFields 必须是本条用例那份，否则 f-note 落在最右列外被跳过
    const target = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('td[data-cell-row="r-1"][data-cell-field="f-num"]');
      if (!el || document.querySelectorAll('td[data-cell-field="f-note"]').length === 0) {
        throw new Error("三列还没渲染出来");
      }
      return el;
    });
    await user.click(target);
    await user.keyboard("{Escape}");

    // jsdom 没有可用的 DataTransfer：手搓一个 paste 事件，只把 handler 真正读的 clipboardData.getData 挂上
    const pasteEvt = new Event("paste", { bubbles: true, cancelable: true });
    Object.assign(pasteEvt, { clipboardData: { getData: () => "7\t甲\n8\t乙\n9\t丙" } });
    fireEvent(target, pasteEvt);

    await waitFor(() => expect(callsFor("cell_set_many")).toHaveLength(1));
    // 三行数据落在只有两行的表上：缺的那一行由一次 row_create_many 建出来，不是逐行 await
    expect(callsFor("row_create_many")).toHaveLength(1);
    const createdIds = (callsFor("row_create_many")[0].args?.ids as string[] | undefined) ?? [];
    expect(createdIds).toHaveLength(1);

    const writes = cellWrites();
    expect(writes.map((u) => [u.row_id, u.field_id, u.value])).toEqual([
      ["r-1", "f-num", "7"],
      ["r-1", "f-note", '"甲"'],
      ["r-2", "f-num", "8"],
      ["r-2", "f-note", '"乙"'],
      [createdIds[0], "f-num", "9"],
      [createdIds[0], "f-note", '"丙"'],
    ]);
    expect(toastSuccess).toHaveBeenCalledWith("已粘贴 6 个单元格");
    expect(toastWarning).not.toHaveBeenCalled();
  });
});

describe("GridView 的 CSV 追加到当前表", () => {
  it("按列名匹配字段建行写格，不建新视图，匹配不上的列出声", async () => {
    const user = userEvent.setup();
    // 表里只有 名称/数量 两字段：CSV 的第三列「备注」匹配不到，整列跳过
    setIpcHandlers({
      ...twoByTwo(),
      read_text_file: () => "名称,数量,备注\n甲,3,x\n乙,4,y\n",
      row_create_many: echoCreatedRows,
      cell_set_many: () => 4,
    });
    queueOpenDialog("D:/data/订单.csv");
    render(<GridView view={view} source={view} />);

    await user.click(await screen.findByRole("button", { name: "导入" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("radio", { name: /追加到/ }));
    await user.click(within(dialog).getByRole("button", { name: "导入" }));

    await waitFor(() => expect(callsFor("cell_set_many")).toHaveLength(1));
    // 追加既建新表也不走 csv_import：那是「导入为新表」那条路的命令
    expect(callsFor("view_create")).toHaveLength(0);
    expect(callsFor("csv_import")).toHaveLength(0);
    expect(callsFor("row_create_many")).toHaveLength(1);
    const createdIds = (callsFor("row_create_many")[0].args?.ids as string[] | undefined) ?? [];
    expect(createdIds).toHaveLength(2);

    const writes = cellWrites();
    expect(writes.map((u) => [u.row_id, u.field_id, u.value])).toEqual([
      [createdIds[0], "f-name", '"甲"'],
      [createdIds[0], "f-num", "3"],
      [createdIds[1], "f-name", '"乙"'],
      [createdIds[1], "f-num", "4"],
    ]);
    expect(toastSuccess).toHaveBeenCalledWith("已追加 2 行");
    expect(toastWarning).toHaveBeenCalledWith("已跳过 1 列（字段名未匹配或目标只读）");
  });
});
