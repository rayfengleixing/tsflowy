// @vitest-environment jsdom
// 组件级交互测试：验证「改字段类型必须先确认」这条数据保护在真实 DOM 里成立。
// 纯逻辑测试（node 环境）看不到 radix 菜单与对话框的开合，这类破坏性操作恰恰只能这样验。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/i18n", () => ({ t: (key: string) => key }));

import { FieldTypeMenu } from "./FieldTypeMenu";

afterEach(() => cleanup());

const TYPES = ["text", "number", "date"] as const;

function renderMenu(onSelect = vi.fn()) {
  render(<FieldTypeMenu types={TYPES} current="text" fieldName="预算" onSelect={onSelect} testid="field-type-menu" />);
  return onSelect;
}

describe("FieldTypeMenu：图标入口改类型", () => {
  it("选中目标类型只弹确认框，确认后才回调", async () => {
    const user = userEvent.setup();
    const onSelect = renderMenu();

    await user.click(screen.getByTestId("field-type-menu"));
    await user.click(await screen.findByRole("menuitem", { name: /field\.type\.number/ }));

    expect(await screen.findByText("field.confirmChangeTypeTitle")).toBeTruthy();
    // 确认之前一次写入都不该发生：改类型在库层是整列取值清空
    expect(onSelect).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "field.changeType" }));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith("number"));
  });

  it("取消就什么都不改，菜单可以重新打开", async () => {
    const user = userEvent.setup();
    const onSelect = renderMenu();

    await user.click(screen.getByTestId("field-type-menu"));
    await user.click(await screen.findByRole("menuitem", { name: /field\.type\.date/ }));
    await user.click(await screen.findByRole("button", { name: "common.cancel" }));

    expect(onSelect).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("field-type-menu"));
    expect(await screen.findByRole("menuitem", { name: /field\.type\.date/ })).toBeTruthy();
  });

  it("当前类型那条是禁用项，点它不会弹确认", async () => {
    const user = userEvent.setup();
    const onSelect = renderMenu();

    await user.click(screen.getByTestId("field-type-menu"));
    const current = await screen.findByRole("menuitem", { name: /field\.type\.text/ });
    expect(current.getAttribute("data-disabled")).not.toBeNull();
    await user.click(current);

    expect(screen.queryByText("field.confirmChangeTypeTitle")).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
