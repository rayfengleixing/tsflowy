// @vitest-environment jsdom
// 单元格内联编辑器的第三子批（V 批 3/3：附件 + 关联）。前两批钉的都是「交出去的那个值」，这两族多一层：
// 添加动作要跨过原生边界（文件对话框 / 字节落盘 / 系统默认程序 / 目标库快照），所以断言落在两处——
// 「交给 onCommit / onCancel 的那个值」与「递给 IPC 边界的那组参数」。
//
// mock 口径（探针跑过两轮，不是猜的）：
// ① 只 mock 到 @/lib/invoke、@/lib/ipc-core、@/lib/ipc-dialog 三条边界，@/lib/assets 与 @/lib/relation
//    用**真实现**：filesFromDataTransfer 的 0 字节过滤与 items 兜底、saveAttachmentFile 的 bytes/ext 推导、
//    relationRowLabel 的主字段解析都是这批要钉的行为，替身把它们换掉就只剩「测了个 mock」。
//    于是断言写成 callsFor("save_asset_bytes")，钉的是真正递给 Rust 的那组参数。
// ② jsdom 没有 ClipboardEvent（typeof 就是 "undefined"），粘贴只能用 new Event("paste", {bubbles, cancelable})
//    再把 clipboardData 定义到事件上派发给 document。
// ③ `fireEvent.drop(el, { dataTransfer: 替身 })` 送得进 React——RTL 把 init 上不认识的键逐个定义到事件对象。
//    但这两类事件的 **fireEvent 返回值判不出 preventDefault**（探针实测：连挂在元素上的原生监听调了
//    preventDefault，返回值仍是 false）。判得出的那一面是事件冒到 document 时的 defaultPrevented，
//    所以下面用 withPreventedCheck 在 document 上读数，而不是拿 fireEvent 的返回值当证据。
// ④ busy 那道闸门要一个**永不 resolve** 的 handler 才看得见（tauri-mock 默认立刻兑现，等点击返回时
//    finally 早把 busy 放回 false）：setIpcHandler("save_asset_bytes", () => new Promise<never>(() => undefined))。
// ⑤ 粘贴的 effect 没有依赖数组，每次渲染都摘旧监听再挂新的。可观察的两面是「重渲染后第二次粘贴只加一次」
//    （漏了 cleanup 会变两次）与「卸载后粘贴不再响应」。
// ⑥ 图片缩略图的 src 由 ipc-core 的 appDataDir/join/convertFileSrc 替身拼出来，读得回来；jsdom 不真的加载
//    图片，所以只断「渲染成 img 且 alt 是文件名」，不断加载成败。
// ⑦ 关联的 ensure 用 setState 换成 spy：真实现会去打 databaseApi 三条 IPC，而「有没有为这个目标库拉一次」
//    本身就是要钉的行为，数据则由测试直接塞进 store。
//
// 边界外的仍然要说清：真的系统文件对话框、真的拖拽手势（HTML5 dnd 在 jsdom 里只能派发合成事件）、
// 真的用系统程序打开附件，这三样只有原生窗口里才成立，本批只能在「递给边界的参数」这一层钉。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { AttachmentCellEditor, CellEditorSlot, RelationCellEditor } from "./editors";
import type { CellValue, DatabaseField, DatabaseRow, FieldType } from "@/types/database";
import { useRelationStore } from "@/stores/relation";
import type { RelationDb } from "@/lib/database/relation";
import { resetStores } from "@/test/store-reset";
import { callsFor, open, queueOpenDialog, resetIpcMock, setIpcHandler, setIpcHandlers } from "@/test/tauri-mock";

vi.mock("@/lib/i18n", () => ({
  t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
}));
// 三条原生边界：命令通道、路径/URL、文件对话框。sonner 只留 error（失败提示的落点）。
vi.mock("@/lib/invoke", async () => ({ invoke: (await import("@/test/tauri-mock")).invoke }));
vi.mock("@/lib/ipc/ipc-core", async () => (await import("@/test/tauri-mock")).ipcCoreMock());
vi.mock("@/lib/ipc/ipc-dialog", async () => (await import("@/test/tauri-mock")).ipcDialogMock());
vi.mock("@/lib/ipc/ipc-shell", async () => (await import("@/test/tauri-mock")).ipcShellMock());
const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }));

beforeEach(() => {
  cleanup();
  resetIpcMock();
  // 关联编辑器读的是模块级 relation store 单例，cleanup() 不动它
  resetStores();
  toastError.mockReset();
});

const TARGET = "v-t";

function fieldOf(type: FieldType, options?: unknown): DatabaseField {
  return {
    id: "f-1",
    database_view_id: "v-1",
    name: "列",
    field_type: type,
    options: options === undefined ? "" : JSON.stringify(options),
    width: 160,
    is_hidden: 0,
    position: 0,
  };
}

function relationField(targetViewId: string = TARGET): DatabaseField {
  return fieldOf("relation", { kind: "relation", target_view_id: targetViewId });
}

function spies() {
  return { onCommit: vi.fn(), onCancel: vi.fn() };
}

/** 目标库快照：一个可见文本主字段 + 每行一个标题（行序就是 titles 的顺序） */
function dbOf(titles: string[]): RelationDb {
  const primary: DatabaseField = {
    id: "ft",
    database_view_id: TARGET,
    name: "标题",
    field_type: "text",
    options: "",
    width: 120,
    is_hidden: 0,
    position: 0,
  };
  const rows: DatabaseRow[] = titles.map((_, i) => ({
    id: `r${i}`,
    database_view_id: TARGET,
    position: i,
    document_id: null,
    parent_id: null,
    created_at: 0,
    updated_at: 0,
  }));
  const cells: Record<string, Record<string, CellValue>> = {};
  rows.forEach((row, i) => {
    cells[row.id] = { ft: titles[i] };
  });
  return { fields: [primary], rows, cells };
}

/** 把快照直接塞进 store（ensure 换成 no-op spy，免得真实现去打 databaseApi） */
function putDb(db: RelationDb, viewId: string = TARGET) {
  useRelationStore.setState({ data: { [viewId]: db }, ensure: vi.fn() });
}

function spyEnsure(): ReturnType<typeof vi.fn> {
  const ensure = vi.fn();
  useRelationStore.setState({ data: {}, ensure });
  return ensure;
}

function mountAttachment(value: CellValue, s = spies()) {
  render(<AttachmentCellEditor field={fieldOf("attachment")} value={value} {...s} />);
  return s;
}

function mountRelation(value: CellValue, s = spies(), targetViewId?: string) {
  render(<RelationCellEditor field={relationField(targetViewId)} value={value} {...s} />);
  return s;
}

/** 点击外部那一层：与面板平级的 fixed inset-0（两个编辑器都这么写，同一次只会有一个在挂载） */
function backdrop(): HTMLElement {
  const el = [...document.querySelectorAll("div")].find((d) => d.className === "fixed inset-0 z-10");
  if (!el) throw new Error("夹具里没有点击外部的那层 backdrop");
  return el;
}

/** 下拉面板本体（拖放与悬停的目标） */
function dropZone(): HTMLElement {
  const el = [...document.querySelectorAll("div")].find((d) => d.className.includes("absolute inset-x-0 top-full"));
  if (!el) throw new Error("夹具里没有下拉面板");
  return el;
}

function file(name: string, bytes: number[] = [1]): File {
  return new File([new Uint8Array(bytes)], name, { type: "application/octet-stream" });
}

/** ②：jsdom 没有 ClipboardEvent，只能自己造一个带 clipboardData 的 paste 事件；返回值用来读 defaultPrevented */
function paste(dt: { files: File[]; items?: unknown[] }): Event {
  const ev = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "clipboardData", { value: { files: dt.files, items: dt.items ?? [] } });
  document.dispatchEvent(ev);
  return ev;
}

/** ③：drag / drop 这两类事件上 `fireEvent` 的返回值判不出 preventDefault（探针实测：连挂在元素上的原生
 *  监听调了 preventDefault，返回值仍是 false）。判得出的那一面是事件冒到 document 时的 defaultPrevented。 */
function withPreventedCheck(kind: "drop" | "dragover", fire: () => void): boolean {
  let prevented = false;
  const spy = (e: Event) => {
    prevented = e.defaultPrevented;
  };
  document.addEventListener(kind, spy);
  try {
    fire();
  } finally {
    document.removeEventListener(kind, spy);
  }
  return prevented;
}

function drop(dt: { files: File[]; items?: unknown[] }): boolean {
  return withPreventedCheck("drop", () => {
    fireEvent.drop(dropZone(), { dataTransfer: { files: dt.files, items: dt.items ?? [] } });
  });
}

function dragOver(): boolean {
  return withPreventedCheck("dragover", () => {
    fireEvent.dragOver(dropZone(), { dataTransfer: { files: [], items: [] } });
  });
}

/** 让 save_asset_bytes 每次返回新的相对路径 */
function stubSaveBytes() {
  let seq = 0;
  setIpcHandler("save_asset_bytes", () => `assets/${++seq}.bin`);
}

/** 与 V 批 1 同一口径：本仓的 tsc 与 eslint 对 getByRole / getByPlaceholderText 的返回类型判断相反
 *  （一个说断言多余、一个说取不到 .disabled / .value），所以按标签取元素，形状由函数签名给出。 */
function addBtn(): HTMLButtonElement {
  const el = [...document.querySelectorAll("button")].find((b) => b.textContent === "field.attachmentAdd");
  if (!el) throw new Error("夹具里没有「添加附件」按钮");
  return el;
}

function searchBox(): HTMLInputElement {
  const el = document.querySelector("input");
  if (!el) throw new Error("夹具里没有关联搜索框");
  return el;
}

/** 候选列表容器：与「已选预览」那条分开取。混在一起取 button 会把胶囊上的 X 数成第一行。 */
function candidateButtons(): HTMLElement[] {
  const list = [...dropZone().querySelectorAll("div")].find((d) => d.className.includes("min-h-0 flex-1"));
  if (!list) throw new Error("夹具里没有候选列表");
  return [...list.querySelectorAll("button")];
}

function clickCandidate(label: string): void {
  const btn = candidateButtons().find((b) => b.textContent === label);
  if (!btn) throw new Error(`候选列表里没有「${label}」`);
  fireEvent.click(btn);
}

const saveArgs = () => callsFor("save_asset_bytes").map((c) => c.args as { bytes: number[]; ext: string });

/** 微任务与一轮定时器都走完（「压根没发出去」这类否定断言要给它失败的机会） */
const settle = () => new Promise((r) => setTimeout(r, 10));

describe("附件：三条添加路都只改本地 draft，交出那一下才落库", () => {
  it("空 draft 给空态文案，粘贴提示常驻，没有删除按钮", () => {
    mountAttachment([]);
    expect(screen.getByText("field.attachmentEmpty")).toBeTruthy();
    expect(screen.getByText("field.attachmentPasteHint")).toBeTruthy();
    expect(screen.queryAllByTitle("common.delete")).toHaveLength(0);
  });

  it("脏存量：只有 name 与 path 都是字符串的才成行", () => {
    const junk = [
      { name: "一.pdf", path: "assets/1.pdf" },
      "裸字符串",
      { name: "缺 path" },
      7,
      null,
    ] as unknown as CellValue;
    mountAttachment(junk);
    expect(screen.getByText("一.pdf")).toBeTruthy();
    expect(screen.queryAllByTitle("common.delete")).toHaveLength(1);
  });

  it("对话框选中：save_asset 带的是所选路径，名字取基名，接在存量之后，点外部才交", async () => {
    setIpcHandlers({ save_asset: () => "assets/7.pdf" });
    queueOpenDialog("D:\\下载\\报告.pdf");
    const s = mountAttachment([{ name: "存量.pdf", path: "assets/old.pdf" }]);

    fireEvent.click(addBtn());

    await waitFor(() => expect(screen.getByText("报告.pdf")).toBeTruthy());
    expect(open).toHaveBeenCalledWith({ multiple: false });
    expect(callsFor("save_asset")).toEqual([{ cmd: "save_asset", args: { sourcePath: "D:\\下载\\报告.pdf" } }]);
    expect(s.onCommit).not.toHaveBeenCalled();

    fireEvent.mouseDown(backdrop());
    expect(s.onCommit).toHaveBeenCalledWith([
      { name: "存量.pdf", path: "assets/old.pdf" },
      { name: "报告.pdf", path: "assets/7.pdf" },
    ]);
    expect(s.onCancel).not.toHaveBeenCalled();
  });

  it("对话框取消：一条都不追加，按钮回到可点", async () => {
    queueOpenDialog(null);
    const s = mountAttachment([]);

    fireEvent.click(addBtn());

    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(callsFor("save_asset")).toHaveLength(0);
    expect(addBtn().disabled).toBe(false);
    fireEvent.mouseDown(backdrop());
    expect(s.onCommit).toHaveBeenCalledWith([]);
  });

  it("对话框那一路写失败：与拖拽同一句上传错误，且不追加半个引用", async () => {
    setIpcHandler("save_asset", () => Promise.reject(new Error("复制被拒")));
    queueOpenDialog("D:\\下载\\坏.pdf");
    const s = mountAttachment([]);

    fireEvent.click(addBtn());

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastError).toHaveBeenCalledWith('error.upload:{"message":"Error: 复制被拒"}');
    expect(addBtn().disabled).toBe(false);
    fireEvent.mouseDown(backdrop());
    expect(s.onCommit).toHaveBeenCalledWith([]);
  });

  it("保存途中 busy 关闸：按钮 disabled，第二次拖入不再发 IPC", async () => {
    // ④：handler 永不 resolve，busy 才停在 true 上
    setIpcHandler("save_asset_bytes", () => new Promise<never>(() => undefined));
    mountAttachment([]);

    drop({ files: [file("一.bin")] });
    await waitFor(() => expect(addBtn().disabled).toBe(true));
    expect(addBtn().hasAttribute("disabled")).toBe(true);

    drop({ files: [file("二.bin")] });
    fireEvent.click(addBtn());
    expect(callsFor("save_asset_bytes")).toHaveLength(1);
    expect(open).not.toHaveBeenCalled();
  });

  it("拖入两个文件：先悬停再松手，逐个存字节（带各自的 bytes 与 ext），顺序进 draft", async () => {
    stubSaveBytes();
    const s = mountAttachment([]);

    // 悬停那一下也吃掉默认行为，否则浏览器根本不会给 drop
    expect(dragOver()).toBe(true);
    expect(dropZone().className).toContain("border-brand-500");
    const prevented = drop({ files: [file("一.bin", [1]), file("二.bin", [2, 3])] });

    expect(prevented).toBe(true);
    await waitFor(() => expect(screen.getByText("二.bin")).toBeTruthy());
    expect(screen.queryByText("field.attachmentDropHint")).toBeNull();
    expect(saveArgs()).toEqual([
      { bytes: [1], ext: "bin" },
      { bytes: [2, 3], ext: "bin" },
    ]);
    fireEvent.mouseDown(backdrop());
    expect(s.onCommit).toHaveBeenCalledWith([
      { name: "一.bin", path: "assets/1.bin" },
      { name: "二.bin", path: "assets/2.bin" },
    ]);
  });

  it("拖入的全是 0 字节：一条 IPC 都不发（空列表闸门）", async () => {
    stubSaveBytes();
    const s = mountAttachment([]);

    drop({ files: [new File([], "空.bin", { type: "application/octet-stream" })] });

    await settle();
    expect(callsFor("save_asset_bytes")).toHaveLength(0);
    fireEvent.mouseDown(backdrop());
    expect(s.onCommit).toHaveBeenCalledWith([]);
  });

  it("files 空但 items 里有文件：按 items 兜底存一次", async () => {
    stubSaveBytes();
    mountAttachment([]);
    const f = file("只有 item.bin", [9]);

    drop({ files: [], items: [{ kind: "file", getAsFile: () => f }] });

    await waitFor(() => expect(screen.getByText("只有 item.bin")).toBeTruthy());
    expect(saveArgs()).toEqual([{ bytes: [9], ext: "bin" }]);
  });

  it("中途一个文件写失败：已存的那个也不进 draft，只弹一次上传错误", async () => {
    let n = 0;
    setIpcHandler("save_asset_bytes", () => {
      n += 1;
      return n === 1 ? "assets/ok.bin" : Promise.reject(new Error("磁盘写不进"));
    });
    const s = mountAttachment([{ name: "存量.pdf", path: "assets/old.pdf" }]);

    drop({ files: [file("一.bin"), file("二.bin")] });

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastError).toHaveBeenCalledWith('error.upload:{"message":"Error: 磁盘写不进"}');
    expect(screen.queryByText("一.bin")).toBeNull();
    fireEvent.mouseDown(backdrop());
    expect(s.onCommit).toHaveBeenCalledWith([{ name: "存量.pdf", path: "assets/old.pdf" }]);
  });

  it("粘贴带文件：同一条存字节路，且吃掉事件（不再传给编辑器正文）", async () => {
    stubSaveBytes();
    const s = mountAttachment(null);

    const ev = paste({ files: [file("粘贴.bin", [7])] });

    expect(ev.defaultPrevented).toBe(true);
    await waitFor(() => expect(screen.getByText("粘贴.bin")).toBeTruthy());
    expect(saveArgs()).toEqual([{ bytes: [7], ext: "bin" }]);
    fireEvent.mouseDown(backdrop());
    expect(s.onCommit).toHaveBeenCalledWith([{ name: "粘贴.bin", path: "assets/1.bin" }]);
  });

  it("粘贴接在存量之后：追加而不是覆盖，顺序是存量在前", async () => {
    stubSaveBytes();
    const s = mountAttachment([{ name: "存量.pdf", path: "assets/old.pdf" }]);

    paste({ files: [file("新.bin")] });
    await waitFor(() => expect(screen.getByText("新.bin")).toBeTruthy());

    expect(screen.getByText("存量.pdf")).toBeTruthy();
    fireEvent.mouseDown(backdrop());
    expect(s.onCommit).toHaveBeenCalledWith([
      { name: "存量.pdf", path: "assets/old.pdf" },
      { name: "新.bin", path: "assets/1.bin" },
    ]);
  });

  it("粘贴的是纯文本：什么都不发，也不吃掉事件", async () => {
    stubSaveBytes();

    const ev = paste({ files: [] });

    expect(ev.defaultPrevented).toBe(false);
    await settle();
    expect(callsFor("save_asset_bytes")).toHaveLength(0);
  });

  it("重渲染后粘贴仍只加一次；卸载后不再响应（无依赖数组的 effect 每次都重挂）", async () => {
    stubSaveBytes();
    mountAttachment(null);

    paste({ files: [file("一.bin")] });
    await waitFor(() => expect(screen.getByText("一.bin")).toBeTruthy());
    // 走到这里已经因 setDraft 重渲染过一次：漏了 cleanup 的话这条粘贴会被两个监听各处理一次
    expect(callsFor("save_asset_bytes")).toHaveLength(1);

    paste({ files: [file("二.bin")] });
    await waitFor(() => expect(callsFor("save_asset_bytes")).toHaveLength(2));
    expect(screen.getByText("二.bin")).toBeTruthy();

    cleanup();
    paste({ files: [file("三.bin")] });
    await settle();
    expect(callsFor("save_asset_bytes")).toHaveLength(2);
  });

  it("图片名渲染成缩略图（src 由 asset 路径拼出），非图片只有图标", async () => {
    mountAttachment([
      { name: "照片.png", path: "assets/a.png" },
      { name: "说明.pdf", path: "assets/b.pdf" },
    ]);

    await waitFor(() => expect(document.querySelector("img")).toBeTruthy());
    const img = document.querySelector("img")!;
    expect(img.getAttribute("alt")).toBe("照片.png");
    expect(img.getAttribute("src")).toBe("/mock/app-data/assets/a.png");
    expect(document.querySelectorAll("img")).toHaveLength(1);
  });

  it("点名字走 open_asset 并带上相对路径；打开失败弹错且不动 draft", async () => {
    setIpcHandler("open_asset", () => Promise.reject(new Error("没有关联程序")));
    const s = mountAttachment([
      { name: "一.pdf", path: "assets/1.pdf" },
      { name: "二.pdf", path: "assets/2.pdf" },
    ]);

    fireEvent.click(screen.getByText("二.pdf"));

    await waitFor(() => expect(callsFor("open_asset")).toHaveLength(1));
    expect(callsFor("open_asset")[0].args).toEqual({ relative: "assets/2.pdf" });
    expect(toastError).toHaveBeenCalledWith('error.openAttachment:{"message":"Error: 没有关联程序"}');
    expect(s.onCommit).not.toHaveBeenCalled();

    fireEvent.mouseDown(backdrop());
    expect(s.onCommit).toHaveBeenCalledWith([
      { name: "一.pdf", path: "assets/1.pdf" },
      { name: "二.pdf", path: "assets/2.pdf" },
    ]);
  });

  it("X 只从 draft 里去掉那一条：不当场提交，交出的是剩下的", () => {
    const s = mountAttachment([
      { name: "一.pdf", path: "assets/1.pdf" },
      { name: "二.pdf", path: "assets/2.pdf" },
    ]);

    fireEvent.click(screen.getAllByTitle("common.delete")[1]);

    expect(s.onCommit).not.toHaveBeenCalled();
    expect(screen.getByText("一.pdf")).toBeTruthy();
    expect(screen.queryByText("二.pdf")).toBeNull();
    fireEvent.mouseDown(backdrop());
    expect(s.onCommit).toHaveBeenCalledWith([{ name: "一.pdf", path: "assets/1.pdf" }]);
  });

  it("拖拽悬停换提示（有存量时把列表盖住），离开换回", () => {
    mountAttachment([{ name: "一.pdf", path: "assets/1.pdf" }]);

    expect(dragOver()).toBe(true);
    expect(screen.getByText("field.attachmentDropHint")).toBeTruthy();
    expect(screen.queryByText("一.pdf")).toBeNull();

    fireEvent.dragLeave(dropZone());
    expect(screen.queryByText("field.attachmentDropHint")).toBeNull();
    expect(screen.getByText("一.pdf")).toBeTruthy();
  });

  it("面板内的按下不冒到表格里（外层拦住 mousedown）", () => {
    const outer = vi.fn();
    render(
      <div onMouseDown={outer}>
        <AttachmentCellEditor field={fieldOf("attachment")} value={[]} onCommit={vi.fn()} onCancel={vi.fn()} />
      </div>,
    );

    fireEvent.mouseDown(addBtn());
    fireEvent.mouseDown(screen.getByText("field.attachmentPasteHint"));
    expect(outer).not.toHaveBeenCalled();
  });

  it("交出的是当前 draft 而不是初始值：改动之后点外部才是提交点", async () => {
    stubSaveBytes();
    const s = mountAttachment([{ name: "存量.pdf", path: "assets/old.pdf" }]);

    // 先删掉存量，再走一条粘贴（两条路都只动 draft）
    fireEvent.click(screen.getByTitle("common.delete"));
    paste({ files: [file("新.bin")] });
    await waitFor(() => expect(screen.getByText("新.bin")).toBeTruthy());

    fireEvent.mouseDown(backdrop());
    expect(s.onCommit).toHaveBeenCalledWith([{ name: "新.bin", path: "assets/1.bin" }]);
  });
});

describe("关联：目标库、候选与 draft 交出", () => {
  it("未配置目标：只给 relationUnset，不拉库、没有输入框，点外部等价于取消", () => {
    const ensure = spyEnsure();
    const s = mountRelation(["r0"], undefined, "");

    expect(screen.getByText("field.relationUnset")).toBeTruthy();
    expect(screen.queryByPlaceholderText("field.relationSearch")).toBeNull();
    expect(ensure).not.toHaveBeenCalled();

    fireEvent.mouseDown(backdrop());
    expect(s.onCancel).toHaveBeenCalledTimes(1);
    expect(s.onCommit).not.toHaveBeenCalled();
  });

  it("目标已配但库还没到：显示 app.loading，并且真的为这个目标 ensure 一次", () => {
    const ensure = spyEnsure();

    mountRelation([]);

    expect(screen.getByText("app.loading")).toBeTruthy();
    // 库还没到不是「库里没行」：两条闸门各管各的
    expect(screen.queryByText("field.relationEmpty")).toBeNull();
    expect(ensure).toHaveBeenCalledWith([TARGET]);
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(searchBox()).toBeTruthy();
  });

  it("换目标库：effect 跟着新 id 再拉一次", () => {
    const ensure = spyEnsure();
    const s = spies();
    const view = (targetViewId: string) => <CellEditorSlot field={relationField(targetViewId)} value={[]} {...s} />;

    const { rerender } = render(view("v-a"));
    expect(ensure).toHaveBeenCalledWith(["v-a"]);

    rerender(view("v-b"));
    expect(ensure).toHaveBeenCalledWith(["v-b"]);
    expect(ensure).toHaveBeenCalledTimes(2);
  });

  it("候选按目标库行序列出；51 行只渲染前 50 条", () => {
    putDb(dbOf(Array.from({ length: 51 }, (_, i) => `行${i}`)));

    mountRelation([]);

    expect(candidateButtons()).toHaveLength(50);
    expect(screen.getByText("行0")).toBeTruthy();
    expect(screen.getByText("行49")).toBeTruthy();
    expect(screen.queryByText("行50")).toBeNull();
  });

  it("库里零行时给 relationEmpty，而不是 app.loading", () => {
    putDb(dbOf([]));

    mountRelation([]);

    expect(screen.getByText("field.relationEmpty")).toBeTruthy();
    expect(screen.queryByText("app.loading")).toBeNull();
  });

  it("搜索按整行文本命中（非主字段也算），清空关键词列回全部", () => {
    const primary: DatabaseField = {
      id: "ft",
      database_view_id: TARGET,
      name: "标题",
      field_type: "text",
      options: "",
      width: 120,
      is_hidden: 0,
      position: 0,
    };
    const note: DatabaseField = {
      id: "fn",
      database_view_id: TARGET,
      name: "备注",
      field_type: "text",
      options: "",
      width: 120,
      is_hidden: 0,
      position: 1,
    };
    const mk = (id: string, position: number): DatabaseRow => ({
      id,
      database_view_id: TARGET,
      position,
      document_id: null,
      parent_id: null,
      created_at: 0,
      updated_at: 0,
    });
    useRelationStore.setState({
      data: {
        [TARGET]: {
          fields: [primary, note],
          rows: [mk("r0", 0), mk("r1", 1)],
          cells: { r0: { ft: "苹果", fn: "Red" }, r1: { ft: "香蕉", fn: "Yellow" } },
        },
      },
      ensure: vi.fn(),
    });

    mountRelation([]);

    fireEvent.change(searchBox(), { target: { value: "yellow" } });
    expect(screen.queryByText("苹果")).toBeNull();
    expect(screen.getByText("香蕉")).toBeTruthy();

    fireEvent.change(searchBox(), { target: { value: "" } });
    expect(screen.getByText("苹果")).toBeTruthy();
    expect(screen.getByText("香蕉")).toBeTruthy();
  });

  it("回车加第一条候选并清空输入；没命中时一个都不交、关键词留着", () => {
    putDb(dbOf(["苹果", "香蕉"]));
    const s = mountRelation([]);

    fireEvent.keyDown(searchBox(), { key: "Enter" });
    expect(s.onCommit).not.toHaveBeenCalled();
    expect(screen.getByText("field.selected 1")).toBeTruthy();

    fireEvent.change(searchBox(), { target: { value: "香蕉" } });
    fireEvent.keyDown(searchBox(), { key: "Enter" });
    expect(searchBox().value).toBe("");
    expect(screen.getByText("field.selected 2")).toBeTruthy();

    fireEvent.change(searchBox(), { target: { value: "查不到" } });
    fireEvent.keyDown(searchBox(), { key: "Enter" });
    expect(searchBox().value).toBe("查不到");
    expect(screen.getByText("field.selected 2")).toBeTruthy();
    expect(s.onCommit).not.toHaveBeenCalled();
  });

  it("点候选是 toggle：加一次再点一次取消，选中那行才打勾", () => {
    putDb(dbOf(["苹果", "香蕉"]));
    const s = mountRelation([]);

    clickCandidate("苹果");
    expect(screen.getByText("field.selected 1")).toBeTruthy();

    clickCandidate("香蕉");
    expect(screen.getByText("field.selected 2")).toBeTruthy();

    clickCandidate("苹果");
    expect(screen.getByText("field.selected 1")).toBeTruthy();
    // 打勾只落在被选中的那一行上
    expect(candidateButtons().map((b) => Boolean(b.querySelector("svg.lucide-check")))).toEqual([false, true]);

    fireEvent.mouseDown(backdrop());
    expect(s.onCommit).toHaveBeenCalledWith(["r1"]);
  });

  it("已选预览：胶囊上的 X 取消关联，计数与预览条同进同出", () => {
    putDb(dbOf(["苹果", "香蕉"]));
    const s = mountRelation(["r0", "r1"]);

    expect(screen.getByText("field.selected 2")).toBeTruthy();
    expect(screen.getAllByTitle("field.relationRemove")).toHaveLength(2);
    fireEvent.click(screen.getAllByTitle("field.relationRemove")[0]);
    expect(screen.getByText("field.selected 1")).toBeTruthy();
    expect(s.onCommit).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByTitle("field.relationRemove")[0]);
    expect(screen.queryByText(/field\.selected/)).toBeNull();
    expect(screen.queryByText("common.clearAll")).toBeNull();

    fireEvent.mouseDown(backdrop());
    expect(s.onCommit).toHaveBeenCalledWith([]);
  });

  it("全部清除：draft 归零，交出的就是空关联", () => {
    putDb(dbOf(["苹果", "香蕉"]));
    const s = mountRelation(["r0"]);

    fireEvent.click(screen.getByText("common.clearAll"));

    expect(screen.queryByText(/field\.selected/)).toBeNull();
    expect(s.onCommit).not.toHaveBeenCalled();
    fireEvent.mouseDown(backdrop());
    expect(s.onCommit).toHaveBeenCalledWith([]);
  });

  it("Escape 交出当前 draft，顺序是按下的顺序而不是目标库行序", () => {
    putDb(dbOf(["苹果", "香蕉", "樱桃"]));
    const s = mountRelation(["r1"]);

    clickCandidate("樱桃");
    fireEvent.keyDown(searchBox(), { key: "Escape" });

    expect(s.onCommit).toHaveBeenCalledWith(["r1", "r2"]);
    expect(s.onCancel).not.toHaveBeenCalled();
  });

  it("存量 id 在目标库里已不存在：胶囊显示原始 id，非字符串条目被丢掉", () => {
    putDb(dbOf(["苹果"]));
    const hostile = ["r0", 7, null, "已删的行"] as unknown as CellValue;
    const s = mountRelation(hostile);

    expect(screen.getByText("已删的行")).toBeTruthy();
    expect(screen.getByText("field.selected 2")).toBeTruthy();

    fireEvent.keyDown(searchBox(), { key: "Escape" });
    expect(s.onCommit).toHaveBeenCalledWith(["r0", "已删的行"]);
  });
});

describe("分派：两族各指到自己的编辑器", () => {
  it("relation 指到带搜索框的关联编辑器（并把候选列出来）", () => {
    putDb(dbOf(["苹果"]));

    render(<CellEditorSlot field={relationField()} value={[]} {...spies()} />);

    expect(searchBox()).toBeTruthy();
    expect(screen.getByText("苹果")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "field.attachmentAdd" })).toBeNull();
  });

  it("attachment 指到带「添加附件」按钮的附件编辑器", () => {
    render(<CellEditorSlot field={fieldOf("attachment")} value={[]} {...spies()} />);

    expect(screen.getByRole("button", { name: "field.attachmentAdd" })).toBeTruthy();
    expect(screen.getByText("field.attachmentPasteHint")).toBeTruthy();
    expect(screen.queryByPlaceholderText("field.relationSearch")).toBeNull();
  });
});
