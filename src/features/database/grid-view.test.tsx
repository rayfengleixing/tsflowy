// @vitest-environment jsdom
// CSV 导入的贯穿用例：选文件 → 解析 → 弹类型确认 → 建表落库。
// 这一条链原先只有头（CsvImportDialog 的附件选择）和尾（csv.ts 的解析与类型推断）各自单测，
// 中间的接线（谁把 open() 的结果喂给 read_text_file、确认后调哪条命令）没有覆盖过。
// 现在整条链都在替身上跑：对话框与命令都从 @/lib/ipc-dialog / ipc-core 进来，断言落在命令参数上。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { GridView } from "./GridView";
import {
  callsFor,
  dialogCalls,
  queueOpenDialog,
  queueSaveDialog,
  resetIpcMock,
  setIpcHandlers,
} from "@/test/tauri-mock";
import type { View } from "@/types/models";

vi.mock("@/lib/ipc-core", async () => (await import("@/test/tauri-mock")).ipcCoreMock());
vi.mock("@/lib/ipc-dialog", async () => (await import("@/test/tauri-mock")).ipcDialogMock());
vi.mock("@/lib/ipc-fs", async () => (await import("@/test/tauri-mock")).ipcFsMock());

const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({
  toast: { success: toastSuccess, error: toastError, warning: vi.fn(), info: vi.fn() },
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
  toastSuccess.mockReset();
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
    setIpcHandlers({
      field_list: () => [
        {
          id: "f-name",
          database_view_id: "v-grid",
          name: "名称",
          field_type: "text",
          width: 200,
          is_hidden: 0,
          position: 0,
        },
        {
          id: "f-num",
          database_view_id: "v-grid",
          name: "数量",
          field_type: "number",
          width: 120,
          is_hidden: 0,
          position: 1,
        },
      ],
      row_list: () =>
        ["r-1", "r-2"].map((id, i) => ({
          id,
          database_view_id: "v-grid",
          position: i,
          document_id: null,
          parent_id: null,
          created_at: 0,
          updated_at: 0,
        })),
      cells_load: () => [{ row_id: "r-1", field_id: "f-name", value: JSON.stringify("甲") }],
      write_text_file: () => undefined,
    });
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
});
