// @vitest-environment jsdom
// 表头从 GridView.tsx 切出来时是「搬不改」，但搬出来的那一刻它第一次能单独渲染：
// 排序循环、菜单开合、重命名、列宽拖拽、字段拖落这五件事，原来只能连着整张表在原生窗口里用肉眼验。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";

import { GridHeaderRow } from "./GridHeaderRow";
import { resetStores } from "@/test/store-reset";
import { useDatabaseStore } from "@/stores/database";
import type { DatabaseField, FieldType } from "@/types/database";

vi.mock("@/lib/i18n", () => ({
  t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
}));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn(), warning: vi.fn(), info: vi.fn() } }));

// FieldMenu 有自己的用例（radix 菜单与确认框那套），这里只留一个把 props 原样递出来的替身：
// 表头要验的是「双击把 open 递过去」和「菜单里点了哪条就调哪条」，不是菜单长什么样
const menu = vi.hoisted(() => {
  // 值类型带 undefined：没渲染过那一列的菜单时取到的是 undefined，用例里的 `?.` 才有意义
  const props: Record<string, Record<string, unknown> | undefined> = {};
  return { props };
});
vi.mock("./FieldMenu", () => ({
  FieldMenu: (props: Record<string, unknown>) => {
    const name = String(props.fieldName);
    menu.props[name] = props;
    const fire = (key: string, arg?: unknown) => () => (props[key] as (v?: unknown) => void)(arg);
    return (
      <span data-testid={"menu-" + name} data-open={String(props.open)}>
        <button type="button" data-testid={`m-rename-${name}`} onClick={fire("onRename")} />
        <button type="button" data-testid={`m-relation-${name}`} onClick={fire("onChangeType", "relation")} />
        <button type="button" data-testid={`m-text-${name}`} onClick={fire("onChangeType", "text")} />
        <button type="button" data-testid={`m-hidden-${name}`} onClick={fire("onToggleHidden")} />
        <button type="button" data-testid={`m-delete-${name}`} onClick={fire("onDelete")} />
        <button type="button" data-testid={`m-options-${name}`} onClick={fire("onOpenOptions")} />
      </span>
    );
  },
}));

const fieldOf = (id: string, name: string, fieldType: FieldType, position: number, hidden = 0): DatabaseField => ({
  id,
  database_view_id: "v-grid",
  name,
  field_type: fieldType,
  options: "{}",
  width: 160,
  is_hidden: hidden,
  position,
});
// 名称列是主列（visibleFields 的首列）；f-hidden 不在可见列里，只有拖拽重排会碰到它
const F_NAME = fieldOf("f-name", "名称", "text", 0);
const F_NUM = fieldOf("f-num", "数量", "number", 1);
const F_TAG = fieldOf("f-tag", "标签", "text", 2);
const F_HIDDEN = fieldOf("f-hidden", "备注", "text", 3, 1);
const ALL = [F_NAME, F_NUM, F_TAG, F_HIDDEN];
const VISIBLE = [F_NAME, F_NUM, F_TAG];

const actions = {
  setSorts: vi.fn(),
  renameField: vi.fn().mockResolvedValue(undefined),
  changeFieldType: vi.fn().mockResolvedValue(undefined),
  toggleFieldHidden: vi.fn().mockResolvedValue(undefined),
  removeField: vi.fn().mockResolvedValue(undefined),
  setFieldWidth: vi.fn().mockResolvedValue(undefined),
  reorderFields: vi.fn().mockResolvedValue(undefined),
};
const host = {
  toggleSelectAll: vi.fn(),
  onConfigure: vi.fn(),
};

/** 表头离不开 <table>：列宽拖拽要按 fieldId 找 <col>，所以挂载点连 colgroup 一起给 */
function Harness({ allSelected = false }: { allSelected?: boolean }) {
  const ref = useRef<HTMLTableElement | null>(null);
  return (
    <table ref={ref}>
      <colgroup>
        <col style={{ width: 44 }} />
        {VISIBLE.map((f) => (
          <col key={f.id} data-field-id={f.id} style={{ width: f.width }} />
        ))}
      </colgroup>
      <GridHeaderRow
        visibleFields={VISIBLE}
        primaryField={VISIBLE[0]}
        tableRef={ref}
        allSelected={allSelected}
        onToggleSelectAll={host.toggleSelectAll}
        onConfigure={host.onConfigure}
      />
    </table>
  );
}

const mount = (props?: { allSelected?: boolean }) => render(<Harness {...props} />);
const colOf = (fieldId: string) => document.querySelector<HTMLTableColElement>(`col[data-field-id="${fieldId}"]`);
/** store 改了要先把重渲染刷出来：下一次点击读的是新的 sorts，闭包里的旧值不算 */
const setSorts = (sorts: { field_id: string; dir: "asc" | "desc" }[]) =>
  act(() => {
    useDatabaseStore.setState({ sorts });
  });

beforeEach(() => {
  cleanup();
  resetStores();
  menu.props = {};
  Object.values(actions).forEach((fn) => fn.mockClear());
  Object.values(host).forEach((v) => {
    if (typeof v === "function") (v as ReturnType<typeof vi.fn>).mockClear();
  });
  useDatabaseStore.setState({ fields: ALL, sorts: [], ...actions });
});

describe("GridHeaderRow", () => {
  it("全选按钮：动作交给宿主，勾选态只决定图标", () => {
    mount();
    const selectAll = screen.getByRole("button", { name: "row.selectAll" });
    // 未全选：空心方框，没有那枚高亮类
    expect(selectAll.querySelector("svg")?.getAttribute("class")).not.toContain("text-brand-600");
    fireEvent.click(selectAll);
    expect(host.toggleSelectAll).toHaveBeenCalledTimes(1);

    cleanup();
    mount({ allSelected: true });
    expect(screen.getByRole("button", { name: "row.selectAll" }).querySelector("svg")?.getAttribute("class")).toContain(
      "text-brand-600",
    );
  });

  it("点列名循环排序：追加升序 → 转降序 → 取消；多列排序时第二列出序号", () => {
    mount();
    fireEvent.click(screen.getByText("数量"));
    expect(actions.setSorts).toHaveBeenLastCalledWith([{ field_id: "f-num", dir: "asc" }]);

    // 排过一次之后 store 里就有它了：下一次点击按 store 的当前值走
    setSorts([{ field_id: "f-num", dir: "asc" }]);
    fireEvent.click(screen.getByText("数量"));
    expect(actions.setSorts).toHaveBeenLastCalledWith([{ field_id: "f-num", dir: "desc" }]);

    setSorts([{ field_id: "f-num", dir: "desc" }]);
    fireEvent.click(screen.getByText("数量"));
    expect(actions.setSorts).toHaveBeenLastCalledWith([]);

    // 两列同时排序时第二列要看得见次序号（单列不显示，免得满屏小数字）
    setSorts([
      { field_id: "f-num", dir: "asc" },
      { field_id: "f-tag", dir: "desc" },
    ]);
    expect(screen.getByText("↑")).toBeTruthy();
    expect(screen.getByText("↓")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
  });

  it("双击列头开该列的字段菜单；主列不可拖、菜单标成主列", () => {
    mount();
    expect(menu.props["名称"]?.open).toBe(false);
    fireEvent.doubleClick(screen.getByText("数量"));
    expect(menu.props["数量"]?.open).toBe(true);
    expect(menu.props["名称"]?.open).toBe(false);
    // 关掉：菜单自己报 open=false，表头把状态清成 null
    fireEvent.click(screen.getByTestId("m-delete-数量"));
    expect(menu.props["数量"]?.open).toBe(false);

    expect(menu.props["名称"]?.primary).toBe(true);
    expect(menu.props["数量"]?.primary).toBe(false);
    // 表头 div 上的 draggable：主列假、其余真
    const headOf = (name: string) => screen.getByText(name).closest("div");
    expect(headOf("名称")?.getAttribute("draggable")).toBe("false");
    expect(headOf("数量")?.getAttribute("draggable")).toBe("true");
  });

  it("菜单里的删除与隐藏各自打到 store，并顺手关掉菜单", () => {
    mount();
    fireEvent.doubleClick(screen.getByText("数量"));
    fireEvent.click(screen.getByTestId("m-hidden-数量"));
    expect(actions.toggleFieldHidden).toHaveBeenCalledWith("f-num");
    expect(menu.props["数量"]?.open).toBe(false);

    fireEvent.doubleClick(screen.getByText("标签"));
    fireEvent.click(screen.getByTestId("m-delete-标签"));
    expect(actions.removeField).toHaveBeenCalledWith("f-tag");
    expect(menu.props["标签"]?.open).toBe(false);
  });

  it("重命名：菜单进编辑态，Enter 落库并退出，Escape 不落库", () => {
    mount();
    fireEvent.doubleClick(screen.getByText("数量"));
    fireEvent.click(screen.getByTestId("m-rename-数量"));
    const field = screen.getByRole("textbox", { name: "field.renameField" });
    fireEvent.change(field, { target: { value: "数量（元）" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(actions.renameField).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "field.renameField" })).toBeNull();

    fireEvent.doubleClick(screen.getByText("数量"));
    fireEvent.click(screen.getByTestId("m-rename-数量"));
    const field2 = screen.getByRole("textbox", { name: "field.renameField" });
    fireEvent.change(field2, { target: { value: "数量（元）" } });
    fireEvent.keyDown(field2, { key: "Enter" });
    expect(actions.renameField).toHaveBeenCalledWith("f-num", "数量（元）");
    expect(screen.queryByRole("textbox", { name: "field.renameField" })).toBeNull();
  });

  it("名字没改就不写库：Enter 提交同名只退出编辑态", () => {
    mount();
    fireEvent.doubleClick(screen.getByText("数量"));
    fireEvent.click(screen.getByTestId("m-rename-数量"));
    const field = screen.getByRole("textbox", { name: "field.renameField" });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(actions.renameField).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "field.renameField" })).toBeNull();
  });

  it("改成关联/公式类要接着打开字段设置，改成普通类型不打开", async () => {
    mount();
    fireEvent.doubleClick(screen.getByText("数量"));
    fireEvent.click(screen.getByTestId("m-text-数量"));
    await waitFor(() => expect(actions.changeFieldType).toHaveBeenCalledWith("f-num", "text"));
    expect(host.onConfigure).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("m-relation-标签"));
    await waitFor(() => expect(actions.changeFieldType).toHaveBeenCalledWith("f-tag", "relation"));
    // 设置弹层开的是「改完之后那条字段」：从 store 现读，不是菜单里那份旧对象
    await waitFor(() => expect(host.onConfigure).toHaveBeenCalledWith(F_TAG));
    expect(menu.props["标签"]?.open).toBe(false);
  });

  it("菜单里的「选项设置」把当前字段递给宿主的设置弹层", () => {
    mount();
    fireEvent.doubleClick(screen.getByText("标签"));
    fireEvent.click(screen.getByTestId("m-options-标签"));
    expect(host.onConfigure).toHaveBeenCalledWith(F_TAG);
    expect(menu.props["标签"]?.open).toBe(false);
  });

  it("列宽拖拽：拖动只改 <col> 宽度，松手才落一次库；超出上下限被夹住", () => {
    mount();
    fireEvent.mouseDown(screen.getByTestId("resize-f-num"), { clientX: 100 });
    fireEvent.mouseMove(window, { clientX: 140 });
    expect(colOf("f-num")?.style.width).toBe("200px");
    expect(actions.setFieldWidth).not.toHaveBeenCalled();
    fireEvent.mouseUp(window, { clientX: 140 });
    expect(actions.setFieldWidth).toHaveBeenCalledWith("f-num", 200);

    // 夹到上限 600：松手落库的是夹过的值，不是原始拖距
    fireEvent.mouseDown(screen.getByTestId("resize-f-tag"), { clientX: 0 });
    fireEvent.mouseMove(window, { clientX: 900 });
    expect(colOf("f-tag")?.style.width).toBe("600px");
    fireEvent.mouseUp(window, { clientX: 900 });
    expect(actions.setFieldWidth).toHaveBeenCalledWith("f-tag", 600);
  });

  it("列宽落库失败：撤掉本地预览宽度并出声，不让它顶着假宽度留在屏上", async () => {
    actions.setFieldWidth.mockRejectedValueOnce(new Error("db locked"));
    mount();
    fireEvent.mouseDown(screen.getByTestId("resize-f-num"), { clientX: 100 });
    fireEvent.mouseUp(window, { clientX: 140 });
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(colOf("f-num")?.style.width).toBe("");
  });

  it("拖列换序：主列钉在首位，隐藏列一起进重排（不然会从 store 里被剔掉）", () => {
    mount();
    const headOf = (name: string) => screen.getByText(name).closest("div") as HTMLElement;
    fireEvent.dragStart(headOf("数量"));
    expect(headOf("数量").getAttribute("class")).toContain("opacity-40");

    fireEvent.dragOver(headOf("标签"));
    fireEvent.drop(headOf("标签"));
    expect(actions.reorderFields).toHaveBeenCalledWith(["f-name", "f-tag", "f-num", "f-hidden"]);
    // 落完清拖拽态：那列不再半透明
    expect(headOf("数量").getAttribute("class")).not.toContain("opacity-40");
  });

  it("拖到主列上或拖自己都不重排", () => {
    mount();
    const headOf = (name: string) => screen.getByText(name).closest("div") as HTMLElement;
    fireEvent.dragStart(headOf("数量"));
    fireEvent.drop(headOf("数量"));
    fireEvent.drop(headOf("名称"));
    expect(actions.reorderFields).not.toHaveBeenCalled();
  });
});
