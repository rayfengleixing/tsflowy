// @vitest-environment jsdom
// 单元格内联编辑器的选项族用例（V 批 2/3：单选 / 多选 / 共用的 matchOptions）。
// 这两个编辑器是 editors.tsx 里最重的一段（:297-482，186 行），判定面全在「输入 → 过滤 → 交出去」
// 与「点了但先不交，出去才交」这两条岔路上；V 批 1 那种「Enter / 失焦都提交」的口径在这里不成立。
//
// 夹具与 V 批 1 同形制（i18n 用 key 恒等替身、按标签取输入框），边界只多一个：这一族的 onAddOption
// 是**异步**的（建成功给 id、失败给 null），所以凡是走新建的用例都要等一拍。
//
// 本批另外探到的两件事，直接决定断言落点：
// ① useAutoFocus 的 `focus()` 断得出（activeElement），`select()` 断不出——搜索框初值恒为空串，
//    空串上 select() 与不调用没有任何可观察差别，登记成等价、不为它造断言；
// ② 删除把手是嵌在行 `<button>` 里的 `<span>`，它自己 `stopPropagation`，所以点它只走删除、
//    不会连带把那一行「选中」——单选/多选共有的误操作面，单独钉住。
// ③ 「这条岔路不该崩」是能断的，但口子不在 fireEvent 上：处理器里抛的 TypeError 被 jsdom 交给 window 的
//    error 事件，fireEvent 顶不回来（见 uncaughtWhile 的注释）。没给 onAddOption 那两条就靠它钉守卫。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { CellEditorSlot, MultiSelectCellEditor, SelectCellEditor } from "./editors";
import type { CellValue, DatabaseField, FieldType, SelectOption } from "@/types/database";

vi.mock("@/lib/i18n", () => ({
  t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
}));

beforeEach(() => {
  cleanup();
});

const A: SelectOption = { id: "a", name: "待办", color: "gray" };
const B: SelectOption = { id: "b", name: "进行中", color: "blue" };
const C: SelectOption = { id: "c", name: "Done", color: "green" };

function fieldOf(type: FieldType, options?: SelectOption[]): DatabaseField {
  return {
    id: "f-1",
    database_view_id: "v-1",
    name: "列",
    field_type: type,
    options: options === undefined ? "" : JSON.stringify({ kind: "select", options }),
    width: 160,
    is_hidden: 0,
    position: 0,
  };
}

function spies() {
  return {
    onCommit: vi.fn<(value: CellValue) => void>(),
    onCancel: vi.fn<() => void>(),
  };
}

/** 新建选项的替身：什么名字都建成 fixedId，除非名字里带「崩」——那一档用来钉失败分支 */
function addSpy(fixedId = "new-1") {
  return vi.fn<(name: string) => Promise<string | null>>((name) =>
    Promise.resolve(name.includes("崩") ? null : fixedId),
  );
}

/** 取不到就当场抛，别把 undefined 传进 fireEvent 变成一句 TypeError */
function must<T>(el: T | null | undefined, what: string): T {
  if (el === null || el === undefined) throw new Error(`用例期望${what}`);
  return el;
}

/**
 * 跑一段动作，收回它期间冒到 window 的未捕获异常消息。
 * 探针实测：React 事件处理器里抛出的异常**不会**顶回 `fireEvent`（jsdom 把监听器异常交给 window 的
 * error 事件），所以「这条岔路不该崩」只能这样断——否则运行期崩了用例照样绿。
 */
function uncaughtWhile(action: () => void): string[] {
  const caught: string[] = [];
  const onErr = (e: Event) => caught.push((e as ErrorEvent).message);
  window.addEventListener("error", onErr);
  try {
    action();
  } finally {
    window.removeEventListener("error", onErr);
  }
  return caught;
}

/** 搜索框：弹层里唯一的输入框 */
function searchBox(): HTMLInputElement {
  return must(document.querySelector("input"), "弹层里有一个搜索输入框");
}

/** 弹层滚动区里直接排着的按钮：选项行 + 新建行 + 清除行 */
function listButtons(): HTMLButtonElement[] {
  const box = must(document.querySelector("div.overflow-y-auto"), "弹层里有选项列表容器");
  return Array.from(box.querySelectorAll(":scope > button"));
}

function names(): string[] {
  return listButtons().map((b) => b.textContent ?? "");
}

function rowOf(name: string): HTMLButtonElement {
  return must(
    listButtons().find((b) => b.textContent === name),
    `名为 ${name} 的选项行`,
  );
}

function createRow(): HTMLButtonElement {
  return must(
    listButtons().find((b) => (b.textContent ?? "").startsWith("select.createNew")),
    "新建选项那一行",
  );
}

/** 同上，但允许「不存在」——用于断言新建行**不该**出现的那几条 */
function createRowIfAny(): HTMLButtonElement | undefined {
  return listButtons().find((b) => (b.textContent ?? "").startsWith("select.createNew"));
}

/** 清除行（单选 common.clear / 多选 common.clearAll）；没有就返回 undefined，让用例断「不存在」 */
function clearRow(label: string): HTMLButtonElement | undefined {
  return listButtons().find((b) => b.textContent === label);
}

/** 列表行上「删除这个选项」的小把手（嵌在行按钮里的 span，按列表顺序） */
function deleteHandles(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('span[title="common.delete"]'));
}

/** 预览胶囊上的 X（OptionChip 的 onRemove） */
function chipRemovers(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('button[title="field.removeOption"]'));
}

/** 盖在最外层的「点外面」区域 */
function backdrop(): HTMLElement {
  return must(document.querySelector<HTMLElement>("div.fixed.inset-0"), "弹层外的一层点击捕获");
}

function type(query: string): void {
  fireEvent.change(searchBox(), { target: { value: query } });
}

function pressEnter(): void {
  fireEvent.keyDown(searchBox(), { key: "Enter" });
}

function selectedCount(n: number): void {
  expect(screen.getByText(`field.selected ${n}`)).toBeTruthy();
}

/** 行首那个「已选中」的对勾（Check 的着色类是它唯一的可观察身份） */
function hasTick(row: HTMLButtonElement): boolean {
  return row.querySelector("svg.text-brand-600") !== null;
}

describe("单选：输入的三种落点", () => {
  function mount(value: CellValue, options: SelectOption[] = [A, B, C]) {
    const s = spies();
    const onAdd = addSpy();
    const onDelete = vi.fn<(id: string) => void>();
    render(
      <SelectCellEditor
        field={fieldOf("single_select", options)}
        value={value}
        {...s}
        onAddOption={onAdd}
        onDeleteOption={onDelete}
      />,
    );
    return { ...s, onAdd, onDelete };
  }

  it("打开就把光标交给搜索框（全选那一步在空草稿上断不出）", () => {
    mount(null);
    expect(document.activeElement).toBe(searchBox());
  });

  it("没输入时按原序列出全部选项，末尾跟着清除行", () => {
    mount(null);
    expect(names()).toEqual(["待办", "进行中", "Done", "common.clear"]);
  });

  it("键入按大小写不敏感的子串过滤；子串不是精确名时新建行同时出现", () => {
    mount(null);
    type("do");
    expect(names()).toEqual(["Done", 'select.createNew:{"name":"do"}', "common.clear"]);
  });

  it("只输空白等于没输：列全部、不出新建行、回车什么都不交", () => {
    const { onCommit, onAdd } = mount(null);
    type("   ");
    expect(names()).toEqual(["待办", "进行中", "Done", "common.clear"]);
    expect(createRowIfAny()).toBeUndefined();
    pressEnter();
    expect(onCommit).not.toHaveBeenCalled();
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("已有同名选项（只差大小写）：回车交那条已有的 id，一次都不新建", () => {
    const { onCommit, onAdd } = mount(null);
    type("done");
    // 精确名命中时不该再给「新建 Done」那一行——这是 exact 这一档唯一的外部证据
    expect(createRowIfAny()).toBeUndefined();
    pressEnter();
    expect(onCommit).toHaveBeenCalledWith("c");
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("有子串匹配但没有精确名：回车交过滤结果的第一条", () => {
    const { onCommit, onAdd } = mount(null);
    type("行");
    pressEnter();
    expect(onCommit).toHaveBeenCalledWith("b");
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("一个都没匹配上：出现新建行，回车建完直接选中它", async () => {
    const { onCommit, onAdd } = mount(null);
    type("没匹配的名字");
    expect(createRow().textContent).toBe('select.createNew:{"name":"没匹配的名字"}');
    pressEnter();
    await waitFor(() => expect(onCommit).toHaveBeenCalledWith("new-1"));
    expect(onAdd).toHaveBeenCalledWith("没匹配的名字");
  });

  it("新建失败（resolve null）：不提交，也不把失败当成选中", async () => {
    const { onCommit, onAdd } = mount(null);
    type("崩一下");
    pressEnter();
    await waitFor(() => expect(onAdd).toHaveBeenCalledWith("崩一下"));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("点新建行与回车是同一件事", async () => {
    const { onCommit } = mount(null);
    type("没的名字");
    fireEvent.click(createRow());
    await waitFor(() => expect(onCommit).toHaveBeenCalledWith("new-1"));
  });

  it("没给 onAddOption：匹配不上时不出新建行，回车一个值都不交也不崩", () => {
    const s = spies();
    render(<SelectCellEditor field={fieldOf("single_select", [A])} value={null} {...s} />);
    type("没有的名字");
    expect(createRowIfAny()).toBeUndefined();
    const thrown = uncaughtWhile(pressEnter);
    expect(s.onCommit).not.toHaveBeenCalled();
    // 渲染处那道 onAddOption 闸门挡得住新建行，挡不住回车：createFromQuery 里 `!onAddOption`
    // 是唯一还在干活的那道守卫，去掉它这条回车直接 TypeError（用例层只有 window error 收得到）
    expect(thrown).toEqual([]);
  });

  it("输入框还空着就回车：什么都不交", () => {
    const { onCommit, onAdd } = mount(null);
    pressEnter();
    expect(onCommit).not.toHaveBeenCalled();
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("点某一行 = 直接提交那一行的 id", () => {
    const { onCommit } = mount(null);
    fireEvent.click(rowOf("进行中"));
    expect(onCommit).toHaveBeenCalledWith("b");
  });

  it("当前值那一行打勾；存的值不是字符串时没有一行打勾", () => {
    mount("b");
    expect(rowOf("进行中").className).toContain("bg-brand-100");
    expect(hasTick(rowOf("进行中"))).toBe(true);
    expect(hasTick(rowOf("待办"))).toBe(false);
    cleanup();
    mount(7);
    expect(listButtons().filter((b) => b.className.includes("bg-brand-100"))).toHaveLength(0);
    expect(listButtons().filter(hasTick)).toHaveLength(0);
  });

  it("清除那行点了交 null", () => {
    const { onCommit } = mount("b");
    fireEvent.click(must(clearRow("common.clear"), "单选弹层的清除行"));
    expect(onCommit).toHaveBeenCalledWith(null);
  });

  it("遮罩上一按 = 取消，一个值都不交", () => {
    const { onCommit, onCancel } = mount("b");
    fireEvent.mouseDown(backdrop());
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("Esc 与遮罩同一口径", () => {
    const { onCommit, onCancel } = mount("b");
    fireEvent.keyDown(searchBox(), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("options 不是 select 形状：列表空、给「还没有选项」，但输入仍能新建", async () => {
    const s = spies();
    const onAdd = addSpy();
    render(<SelectCellEditor field={fieldOf("single_select")} value={null} {...s} onAddOption={onAdd} />);
    expect(screen.getByText("field.noOptionsShort")).toBeTruthy();
    type("新名字");
    expect(screen.queryByText("field.noOptionsShort")).toBeNull();
    fireEvent.click(createRow());
    await waitFor(() => expect(s.onCommit).toHaveBeenCalledWith("new-1"));
  });

  it("删除把手只在给了 onDeleteOption 时出现；点它只删选项，不提交也不算选中", () => {
    const { onDelete, onCommit } = mount(null);
    expect(deleteHandles()).toHaveLength(3);
    fireEvent.click(must(deleteHandles()[0], "行上的删除把手"));
    expect(onDelete).toHaveBeenCalledWith("a");
    expect(onCommit).not.toHaveBeenCalled();
    cleanup();
    const bare = spies();
    render(<SelectCellEditor field={fieldOf("single_select", [A])} value={null} {...bare} />);
    expect(deleteHandles()).toHaveLength(0);
  });

  it("弹层里的 mousedown 不冒到宿主", () => {
    const host = vi.fn<() => void>();
    render(
      <div onMouseDown={host}>
        <SelectCellEditor field={fieldOf("single_select", [A])} value={null} {...spies()} />
      </div>,
    );
    fireEvent.mouseDown(searchBox());
    fireEvent.mouseDown(backdrop());
    expect(host).not.toHaveBeenCalled();
  });
});

describe("多选：点选只改本地 draft，交出去那一下才提交", () => {
  function mount(value: CellValue, options: SelectOption[] = [A, B, C]) {
    const s = spies();
    const onAdd = addSpy();
    const onDelete = vi.fn<(id: string) => void>();
    render(
      <MultiSelectCellEditor
        field={fieldOf("multi_select", options)}
        value={value}
        {...s}
        onAddOption={onAdd}
        onDeleteOption={onDelete}
      />,
    );
    return { ...s, onAdd, onDelete };
  }

  it("存量数组里的非字符串项被丢掉，字符串项进预览计数", () => {
    // 库里存的 JSON 不受 TS 约束，塞得进数字与 null；CellValue 的声明类型挡不住，只能从外面喂
    const hostile = ["a", 7, null, "b"] as unknown as CellValue;
    mount(hostile);
    selectedCount(2);
    expect(chipRemovers()).toHaveLength(2);
  });

  it("点的瞬间不提交：连点两行也只改本地", () => {
    const { onCommit } = mount([]);
    fireEvent.click(rowOf("待办"));
    fireEvent.click(rowOf("进行中"));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("遮罩上一按才提交，交出的是选中的插入顺序", () => {
    const { onCommit } = mount([]);
    fireEvent.click(rowOf("进行中"));
    fireEvent.click(rowOf("待办"));
    fireEvent.mouseDown(backdrop());
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(["b", "a"]);
  });

  it("再点已选中的那行 = 取消选择", () => {
    const { onCommit } = mount(["a"]);
    fireEvent.click(rowOf("待办"));
    expect(screen.queryByText(/field\.selected/)).toBeNull();
    fireEvent.mouseDown(backdrop());
    expect(onCommit).toHaveBeenCalledWith([]);
  });

  it("Esc 不取消而是提交——与单选相反的那一条", () => {
    const { onCommit, onCancel } = mount(["a"]);
    fireEvent.keyDown(searchBox(), { key: "Escape" });
    expect(onCommit).toHaveBeenCalledWith(["a"]);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("回车命中已有选项：进 draft 并清空搜索框，不提交也不新建", () => {
    const { onCommit, onAdd } = mount([]);
    type("do");
    pressEnter();
    expect(onCommit).not.toHaveBeenCalled();
    expect(onAdd).not.toHaveBeenCalled();
    expect(searchBox().value).toBe("");
    selectedCount(1);
  });

  it("回车新建成功进 draft、失败留在原地", async () => {
    mount([]);
    type("xyzw");
    pressEnter();
    await waitFor(() => expect(searchBox().value).toBe(""));
    selectedCount(1);
    cleanup();

    const bad = mount([]);
    type("崩一下");
    pressEnter();
    await waitFor(() => expect(bad.onAdd).toHaveBeenCalledWith("崩一下"));
    expect(bad.onCommit).not.toHaveBeenCalled();
    expect(searchBox().value).toBe("崩一下");
  });

  it("多选没给 onAddOption：回车走到新建那档时整条收手，不崩也不交", () => {
    const s = spies();
    render(<MultiSelectCellEditor field={fieldOf("multi_select", [A])} value={[]} {...s} />);
    type("没有的名字");
    const thrown = uncaughtWhile(pressEnter);
    expect(s.onCommit).not.toHaveBeenCalled();
    expect(thrown).toEqual([]);
  });

  it("删掉一个已选中的选项：先从本地 draft 移出，再交给 onDeleteOption，提交时不写回悬空 id", () => {
    const { onCommit, onDelete } = mount(["a", "b"]);
    fireEvent.click(must(deleteHandles()[0], "多选列表的删除把手"));
    expect(onDelete).toHaveBeenCalledWith("a");
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.mouseDown(backdrop());
    expect(onCommit).toHaveBeenCalledWith(["b"]);
  });

  it("预览胶囊上的 X 也能取消选择", () => {
    const { onCommit } = mount(["a", "b"]);
    fireEvent.click(must(chipRemovers()[0], "预览胶囊上的 X"));
    selectedCount(1);
    fireEvent.mouseDown(backdrop());
    expect(onCommit).toHaveBeenCalledWith(["b"]);
  });

  it("「清空全部」只在有选中时出现；点它不提交，之后交出去的是空数组", () => {
    mount([]);
    expect(clearRow("common.clearAll")).toBeUndefined();
    cleanup();

    const s = mount(["a"]);
    fireEvent.click(must(clearRow("common.clearAll"), "多选有选中时的清空全部行"));
    expect(s.onCommit).not.toHaveBeenCalled();
    fireEvent.mouseDown(backdrop());
    expect(s.onCommit).toHaveBeenCalledWith([]);
  });

  it("存的值不是数组：预览不出现，直接按遮罩交出空数组", () => {
    const { onCommit } = mount("a");
    expect(screen.queryByText(/field\.selected/)).toBeNull();
    fireEvent.mouseDown(backdrop());
    expect(onCommit).toHaveBeenCalledWith([]);
  });

  it("已选中的行打勾，没选的不打", () => {
    mount(["b"]);
    expect(rowOf("进行中").className).toContain("bg-brand-100");
    expect(hasTick(rowOf("进行中"))).toBe(true);
    expect(rowOf("待办").className).not.toContain("bg-brand-100");
    expect(hasTick(rowOf("待办"))).toBe(false);
  });

  it("选中的 id 不在选项列表里：计数照算，但画不出胶囊", () => {
    mount(["gone-1", "a"], [A]);
    selectedCount(2);
    expect(chipRemovers()).toHaveLength(1);
  });
});

describe("分派：三个选择类各指到自己的编辑器", () => {
  function slot(type: FieldType) {
    const s = spies();
    render(
      <CellEditorSlot
        field={fieldOf(type, [A])}
        value={type === "multi_select" ? [] : null}
        {...s}
        onAddOption={addSpy()}
      />,
    );
    return s;
  }

  it("single_select 与 status 指到单选编辑器（有「清除」那一行）", () => {
    for (const type of ["single_select", "status"] as const) {
      slot(type);
      expect(searchBox().placeholder).toBe("select.searchOrCreate");
      expect(clearRow("common.clear")).toBeDefined();
      cleanup();
    }
  });

  it("multi_select 指到多选编辑器：同一个搜索框，但没有单选那行「清除」", () => {
    slot("multi_select");
    expect(searchBox().placeholder).toBe("select.searchOrCreate");
    expect(clearRow("common.clear")).toBeUndefined();
  });
});
