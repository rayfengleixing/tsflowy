// @vitest-environment jsdom
// 单元格内联编辑器的直接用例（V 批 1/3：文本 / 数字 / 进度 / 星级 / 日期 / 复选 + 分派表兜底）。
// editors.tsx 726 行 127 个分支，此前 11 个值导出没有一个在任何用例里出现过（结构代理表 Tier1 榜首）。
// 这一族的对外行为全都收在「交给 onCommit / onCancel 的那个值」上，所以断言一律落在提交口径。
// 选项类（单选 / 多选）与关联、附件留给 V 批 2 / 3：它们要替身的是另一套边界，混进来只会让这份夹具变大。
//
// 五件先探过的 jsdom 口径（探针跑过三轮，不是猜的）：
// ① number 输入框把非数字键入折成空串（"abc"、"1e999" 都到不了 handler），所以「非有限数不许写回」
//    只能用**存进来的值**驱动，不能用键入驱动；
// ② date / datetime-local 的受控值读得回来，但 `fireEvent.change` 那一路会被清空——日期这一族只断
//    「按存量值算出的草稿」与「按草稿交出的 ISO」，不模拟日历面板打字；
// ③ `fireEvent.pointerUp` 送不进 React，滑条「松手才提交」要手工派发 bubbles 的 pointerup；
// ④ range 控件把越界的 change 值先夹回 min/max（实测 "150"→"100"、"-20"→"0"），所以组件里那道
//    交出值时的夹回在滑条这条路上是**冗余守卫**，变异删掉它这里不会红（数字框那条路才红）；
// ⑤ type=date 装不下超过 10 位的值（直接赋长串读回来是空串），所以「交出前再截 10 位」是条走不到
//    的死守卫，变异删掉它全绿 —— 登记成等价变异，不当作用例缺口。
//
// 时区：日期编辑器把存量 ISO 按 UTC 解释、再按本地墙钟填进输入框，本地墙钟本身就是判定的一部分；
// 不钉时区等于「用例只在跑它的那台机器的时区下成立」（CI 跑在 UTC 就什么都区分不出来），所以钉死，
// 并让本文件第一条用例自证钉得住。仓库不引 @types/node，src 侧本来也不该碰 process，故只在这里声明形状。
const nodeProcess = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
if (nodeProcess?.env) nodeProcess.env.TZ = "Asia/Shanghai";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import {
  CellEditorSlot,
  CheckboxCellEditor,
  DateCellEditor,
  NumberCellEditor,
  ProgressCellEditor,
  RatingCellEditor,
  TextCellEditor,
} from "./editors";
import type { CellValue, DatabaseField, FieldType } from "@/types/database";

vi.mock("@/lib/i18n", () => ({
  t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
}));

beforeEach(() => {
  cleanup();
});

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

/** 这一族统一按标签取输入框：date / datetime-local 在 jsdom 的 ARIA 映射里没有可访问角色，
 *  而 getByRole 的返回类型在本仓的 tsc 与 eslint 之间口径不一，取不到 .value / .type。 */
function inputs(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll("input"));
}

function firstInput(): HTMLInputElement {
  const el = document.querySelector("input");
  if (el === null) throw new Error("用例期望这里有一个输入框");
  return el;
}

function spies() {
  return { onCommit: vi.fn<(value: CellValue) => void>(), onCancel: vi.fn<() => void>() };
}

/** 松手那一下：jsdom 下只有手工派发 bubbles 的 pointerup 才进得了 React 的 onPointerUp */
function releasePointer(el: Element): void {
  fireEvent(el, new Event("pointerup", { bubbles: true, cancelable: true }));
}

describe("日期这一族的时区前提", () => {
  it("本文件钉在东八区：钉不住就别信下面那两条的墙钟字面量", () => {
    expect(new Date("2026-10-28T00:00:00Z").getHours()).toBe(8);
  });
});

describe("文本族：交出去的是原样草稿", () => {
  it("回车交草稿原文，前后空格不许顺手 trim 掉", () => {
    const s = spies();
    render(<TextCellEditor field={fieldOf("text")} value="甲" onCommit={s.onCommit} onCancel={s.onCancel} />);
    const el = firstInput();
    fireEvent.change(el, { target: { value: " 周报 v2 " } });
    fireEvent.keyDown(el, { key: "Enter" });
    expect(s.onCommit).toHaveBeenCalledTimes(1);
    expect(s.onCommit).toHaveBeenCalledWith(" 周报 v2 ");
  });

  it("草稿只剩空格：交 null，不把空格写进单元格", () => {
    const s = spies();
    render(<TextCellEditor field={fieldOf("text")} value="甲" onCommit={s.onCommit} onCancel={s.onCancel} />);
    const el = firstInput();
    fireEvent.change(el, { target: { value: "   " } });
    fireEvent.keyDown(el, { key: "Enter" });
    expect(s.onCommit).toHaveBeenCalledWith(null);
  });

  it("失焦与回车同一条口径：同样交原文、同样把全空白折成 null", () => {
    const s = spies();
    render(<TextCellEditor field={fieldOf("text")} value="甲" onCommit={s.onCommit} onCancel={s.onCancel} />);
    const el = firstInput();
    fireEvent.change(el, { target: { value: " 原文 " } });
    fireEvent.focusOut(el);
    expect(s.onCommit).toHaveBeenCalledWith(" 原文 ");
    fireEvent.change(el, { target: { value: "  " } });
    fireEvent.focusOut(el);
    expect(s.onCommit).toHaveBeenLastCalledWith(null);
  });

  it("Esc 只取消，一个值都不交", () => {
    const s = spies();
    render(<TextCellEditor field={fieldOf("text")} value="甲" onCommit={s.onCommit} onCancel={s.onCancel} />);
    const el = firstInput();
    fireEvent.change(el, { target: { value: "改了一半" } });
    fireEvent.keyDown(el, { key: "Escape" });
    expect(s.onCancel).toHaveBeenCalledTimes(1);
    expect(s.onCommit).not.toHaveBeenCalled();
  });

  it("存的值不是字符串时草稿从空开始，不把它 String 进框里", () => {
    const s = spies();
    render(<TextCellEditor field={fieldOf("text")} value={123} onCommit={s.onCommit} onCancel={s.onCancel} />);
    const el = firstInput();
    expect(el.value).toBe("");
    fireEvent.focusOut(el);
    expect(s.onCommit).toHaveBeenCalledWith(null);
  });

  it("url 与 email 各给占位提示，普通文本不给", () => {
    render(<TextCellEditor field={fieldOf("text")} value="" {...spies()} />);
    expect(firstInput().placeholder).toBe("");
    cleanup();
    render(<TextCellEditor field={fieldOf("url")} value="" {...spies()} />);
    expect(screen.getByPlaceholderText("https://…")).toBeTruthy();
    cleanup();
    render(<TextCellEditor field={fieldOf("email")} value="" {...spies()} />);
    expect(screen.getByPlaceholderText("name@example.com")).toBeTruthy();
  });
});

describe("数字族：非数字一律折成 null", () => {
  function mount(value: CellValue) {
    const s = spies();
    render(<NumberCellEditor field={fieldOf("number")} value={value} {...s} />);
    return { s, el: firstInput() };
  }

  it("小数与负数收成数字原样交", () => {
    const { s, el } = mount(1);
    fireEvent.change(el, { target: { value: "3.5" } });
    fireEvent.keyDown(el, { key: "Enter" });
    expect(s.onCommit).toHaveBeenLastCalledWith(3.5);
    fireEvent.change(el, { target: { value: "-2" } });
    fireEvent.focusOut(el);
    expect(s.onCommit).toHaveBeenLastCalledWith(-2);
  });

  it("草稿清空交 null，不是 0 也不是空串", () => {
    const { s, el } = mount(7);
    fireEvent.change(el, { target: { value: "" } });
    fireEvent.keyDown(el, { key: "Enter" });
    expect(s.onCommit).toHaveBeenCalledWith(null);
  });

  it("非数字键入在框里就被折成空串：交出去的仍是 null", () => {
    const { s, el } = mount(7);
    fireEvent.change(el, { target: { value: "abc" } });
    expect(el.value).toBe("");
    fireEvent.keyDown(el, { key: "Enter" });
    expect(s.onCommit).toHaveBeenCalledWith(null);
  });

  it("存进来的值不是有限数时不许原样写回：交 null", () => {
    const { s, el } = mount(Number.MAX_VALUE * 10);
    fireEvent.keyDown(el, { key: "Enter" });
    expect(s.onCommit).toHaveBeenCalledTimes(1);
    expect(s.onCommit).toHaveBeenCalledWith(null);
  });

  it("存的值不是数字时草稿从空开始（数字串也不当数字收）", () => {
    const { s, el } = mount("42");
    expect(el.value).toBe("");
    fireEvent.focusOut(el);
    expect(s.onCommit).toHaveBeenCalledWith(null);
  });

  it("Esc 只取消", () => {
    const { s, el } = mount(7);
    fireEvent.change(el, { target: { value: "9" } });
    fireEvent.keyDown(el, { key: "Escape" });
    expect(s.onCancel).toHaveBeenCalledTimes(1);
    expect(s.onCommit).not.toHaveBeenCalled();
  });
});

describe("进度：滑条拖动期间一次都不提交", () => {
  function mount(value: CellValue) {
    const host = vi.fn<() => void>();
    const s = spies();
    render(
      <div onMouseDown={host}>
        <ProgressCellEditor field={fieldOf("progress")} value={value} {...s} />
      </div>,
    );
    return {
      s,
      host,
      slide: inputs()[0],
      num: inputs()[1],
    };
  }

  it("起点收进 0–100 并四舍五入：137 变 100、-5 变 0、3.6 变 4", () => {
    expect(mount(137).num.value).toBe("100");
    cleanup();
    expect(mount(-5).num.value).toBe("0");
    cleanup();
    expect(mount(3.6).num.value).toBe("4");
  });

  it("没存过值时从 0 起步，而不是空框", () => {
    const { num, slide } = mount(null);
    expect(num.value).toBe("0");
    expect(slide.value).toBe("0");
  });

  it("拖动只改本地值，松手那一下提交且只提交一次", () => {
    const { s, slide } = mount(20);
    fireEvent.change(slide, { target: { value: "62" } });
    fireEvent.change(slide, { target: { value: "63" } });
    expect(s.onCommit).not.toHaveBeenCalled();
    releasePointer(slide);
    expect(s.onCommit).toHaveBeenCalledTimes(1);
    expect(s.onCommit).toHaveBeenCalledWith(63);
  });

  // 松手交出的是夹回 0–100 之后的值。注意这条**断不出** commitNum 里那道 Math.min/Math.max：
  // range 控件自己就先夹（实测 "150" 到 handler 时已是 100、"-20" 已是 0，jsdom 与浏览器一致），
  // 删掉那层守卫在这条路上行为不变。同一处改坏在下面的数字框那条路会红——那才是守卫承担的地方。
  it("拖到两端之外：交出的是 100 / 0，野值不落进单元格", () => {
    const { s, slide } = mount(10);
    fireEvent.change(slide, { target: { value: "150" } });
    releasePointer(slide);
    expect(s.onCommit).toHaveBeenLastCalledWith(100);
    fireEvent.change(slide, { target: { value: "-20" } });
    releasePointer(slide);
    expect(s.onCommit).toHaveBeenLastCalledWith(0);
  });

  it("键盘调值逐次提交：方向键 / Home / End 各交一次，别的键不算", () => {
    const { s, slide } = mount(0);
    fireEvent.change(slide, { target: { value: "62" } });
    fireEvent.keyUp(slide, { key: "ArrowRight" });
    expect(s.onCommit).toHaveBeenCalledTimes(1);
    expect(s.onCommit).toHaveBeenLastCalledWith(62);
    fireEvent.keyUp(slide, { key: "End" });
    expect(s.onCommit).toHaveBeenCalledTimes(2);
    fireEvent.keyUp(slide, { key: "Home" });
    expect(s.onCommit).toHaveBeenCalledTimes(3);
    fireEvent.keyUp(slide, { key: "a" });
    expect(s.onCommit).toHaveBeenCalledTimes(3);
  });

  it("数字框回车与失焦都夹到区间；留空交 null", () => {
    const { s, num } = mount(50);
    fireEvent.change(num, { target: { value: "150" } });
    fireEvent.keyDown(num, { key: "Enter" });
    expect(s.onCommit).toHaveBeenLastCalledWith(100);
    fireEvent.change(num, { target: { value: "-20" } });
    fireEvent.focusOut(num);
    expect(s.onCommit).toHaveBeenLastCalledWith(0);
    fireEvent.change(num, { target: { value: "" } });
    fireEvent.keyDown(num, { key: "Enter" });
    expect(s.onCommit).toHaveBeenLastCalledWith(null);
  });

  it("滑条那下的 mousedown 不冒到宿主，数字框那下照常冒", () => {
    const { host, slide, num } = mount(30);
    fireEvent.mouseDown(slide);
    expect(host).not.toHaveBeenCalled();
    fireEvent.mouseDown(num);
    expect(host).toHaveBeenCalledTimes(1);
  });

  it("Esc 取消：整块都归宿主处理，一个值都不交", () => {
    const { s, slide, num } = mount(30);
    fireEvent.keyDown(slide, { key: "Escape" });
    fireEvent.keyDown(num, { key: "Escape" });
    expect(s.onCancel).toHaveBeenCalledTimes(2);
    expect(s.onCommit).not.toHaveBeenCalled();
  });
});

describe("星级：点第 N 颗交 N，再点当前那颗减一星", () => {
  function mount(value: CellValue, options?: unknown) {
    const s = spies();
    render(<RatingCellEditor field={fieldOf("rating", options)} value={value} {...s} />);
    return { s, stars: () => Array.from(document.querySelectorAll("button[title]")) };
  }

  it("满星数按 options；没配或配错回落 5", () => {
    expect(mount(1, { kind: "rating", max: 8 }).stars()).toHaveLength(8);
    cleanup();
    expect(mount(1).stars()).toHaveLength(5);
    cleanup();
    expect(mount(1, { kind: "none" }).stars()).toHaveLength(5);
  });

  it("满星数有上限：options 写 20 也只画 10 颗", () => {
    expect(mount(0, { kind: "rating", max: 20 }).stars()).toHaveLength(10);
  });

  it("点第 N 颗星交 N", () => {
    const { s, stars } = mount(2, { kind: "rating", max: 5 });
    fireEvent.click(stars()[4]);
    expect(s.onCommit).toHaveBeenCalledTimes(1);
    expect(s.onCommit).toHaveBeenCalledWith(5);
  });

  it("再点当前那颗 = 减一星；第 1 颗上再点 = 0 星", () => {
    const { s, stars } = mount(3, { kind: "rating", max: 5 });
    fireEvent.click(stars()[2]);
    expect(s.onCommit).toHaveBeenLastCalledWith(2);
    cleanup();
    const again = mount(1, { kind: "rating", max: 5 });
    fireEvent.click(again.stars()[0]);
    expect(again.s.onCommit).toHaveBeenCalledWith(0);
  });

  it("清除按钮只在有值时出现，点它交 null", () => {
    expect(mount(0).stars()).toHaveLength(5);
    expect(screen.queryByText("common.clear")).toBeNull();
    cleanup();
    const s = mount(2, { kind: "rating", max: 5 });
    expect(s.stars()).toHaveLength(5);
    fireEvent.click(screen.getByText("common.clear"));
    expect(s.s.onCommit).toHaveBeenCalledWith(null);
  });

  it("Esc 取消", () => {
    const { s } = mount(2);
    fireEvent.keyDown(document.querySelector("button[title]")!, { key: "Escape" });
    expect(s.onCancel).toHaveBeenCalledTimes(1);
    expect(s.onCommit).not.toHaveBeenCalled();
  });
});

describe("日期：存量按 UTC 认，交出去的是 ISO", () => {
  function mount(value: CellValue, options?: unknown) {
    const s = spies();
    render(<DateCellEditor field={fieldOf("date", options)} value={value} {...s} />);
    return { s, el: firstInput() };
  }

  const WITH_TIME = { kind: "date", include_time: true };

  it("不带时间：类型是 date，草稿与交出去的都只到日", () => {
    const { s, el } = mount("2026-10-28T09:00:00Z");
    expect(el.type).toBe("date");
    expect(el.value).toBe("2026-10-28");
    fireEvent.keyDown(el, { key: "Enter" });
    expect(s.onCommit).toHaveBeenCalledWith("2026-10-28");
  });

  it("options 里 kind=date 但 include_time 关了：仍是纯日期，不许画成带时间", () => {
    // 这一档是真会落库的写法：FieldOptionsEditor 里把「包含时间」的勾去掉，写下的就是
    // {kind:"date", include_time:false}。只看「没配 options」测不到它——那时 opts.kind 是 none，
    // include_time 这一项根本轮不到判断。
    const { s, el } = mount("2026-10-28T09:00:00Z", { kind: "date", include_time: false });
    expect(el.type).toBe("date");
    expect(el.value).toBe("2026-10-28");
    fireEvent.keyDown(el, { key: "Enter" });
    expect(s.onCommit).toHaveBeenCalledWith("2026-10-28");
  });

  it("带时间：类型是 datetime-local，存量 UTC 换成东八区墙钟填进来", () => {
    const { el } = mount("2026-10-28T09:00:00Z", WITH_TIME);
    expect(el.type).toBe("datetime-local");
    expect(el.value).toBe("2026-10-28T17:00");
  });

  it("存量的 ISO 没写 Z 时也按 UTC 认，不能当成东八区本地", () => {
    const { el } = mount("2026-10-28T09:00:00", WITH_TIME);
    expect(el.value).toBe("2026-10-28T17:00");
  });

  it("带时间回车交出去的是同一时刻的 UTC ISO", () => {
    const { s, el } = mount("2026-10-28T09:00:00Z", WITH_TIME);
    fireEvent.keyDown(el, { key: "Enter" });
    expect(s.onCommit).toHaveBeenCalledWith("2026-10-28T09:00:00.000Z");
    fireEvent.focusOut(el);
    expect(s.onCommit).toHaveBeenLastCalledWith("2026-10-28T09:00:00.000Z");
  });

  it("失焦走和回车同一条：不带时间时仍是截到 10 位的日期串", () => {
    const { s, el } = mount("2026-10-28T09:00:00Z");
    fireEvent.focusOut(el);
    expect(s.onCommit).toHaveBeenCalledWith("2026-10-28");
  });

  it("没存过值：草稿空，交出去的是 null 不是空串", () => {
    const { s, el } = mount(null);
    expect(el.value).toBe("");
    fireEvent.keyDown(el, { key: "Enter" });
    expect(s.onCommit).toHaveBeenCalledWith(null);
  });

  it("存的值不是字符串时不按字符串切（数字进得来也只是空草稿）", () => {
    const { s, el } = mount(1730083200);
    expect(el.value).toBe("");
    fireEvent.focusOut(el);
    expect(s.onCommit).toHaveBeenCalledWith(null);
  });

  it("Esc 取消", () => {
    const { s, el } = mount("2026-10-28", WITH_TIME);
    fireEvent.keyDown(el, { key: "Escape" });
    expect(s.onCancel).toHaveBeenCalledTimes(1);
    expect(s.onCommit).not.toHaveBeenCalled();
  });
});

describe("复选框：点击即切换", () => {
  function mount(value: CellValue) {
    const s = spies();
    render(<CheckboxCellEditor field={fieldOf("checkbox")} value={value} {...s} />);
    return { s, button: screen.getByRole("button") };
  }

  it("没勾的一律交 true：null / 空串 / 字符串 true 都算没勾", () => {
    for (const value of [null, "", "true"]) {
      const { s, button } = mount(value);
      fireEvent.click(button);
      expect(s.onCommit).toHaveBeenLastCalledWith(true);
      cleanup();
    }
  });

  it("勾着的点一下交 false", () => {
    const { s, button } = mount(true);
    fireEvent.click(button);
    expect(s.onCommit).toHaveBeenCalledWith(false);
  });

  it("勾上才画对勾：未勾时框里什么都没有", () => {
    mount(false);
    expect(document.querySelector("svg")).toBeNull();
    cleanup();
    mount(true);
    expect(document.querySelector("svg")).toBeTruthy();
  });
});

describe("分派表：字段类型 → 编辑器", () => {
  const INPUT_TYPE: [FieldType, string][] = [
    ["number", "number"],
    ["currency", "number"],
    ["date", "date"],
    ["created_at", "date"],
    ["last_edited_at", "date"],
    ["text", "text"],
    ["url", "text"],
    ["phone", "text"],
    ["email", "text"],
    ["formula", "text"],
    ["rollup", "text"],
    ["reverse_relation", "text"],
  ];

  it.each(INPUT_TYPE)("%s 指到 type=%s 的那个编辑器", (type, expected) => {
    render(<CellEditorSlot field={fieldOf(type)} value={null} {...spies()} />);
    expect(firstInput().type).toBe(expected);
  });

  it("progress 指到带滑条的编辑器，rating 与 checkbox 都不带输入框", () => {
    render(<CellEditorSlot field={fieldOf("progress")} value={40} {...spies()} />);
    expect(screen.getByRole("slider")).toBeTruthy();
    expect(screen.getByText("%")).toBeTruthy();
    cleanup();
    render(<CellEditorSlot field={fieldOf("rating")} value={2} {...spies()} />);
    expect(document.querySelectorAll("button[title]")).toHaveLength(5);
    expect(document.querySelector("input")).toBeNull();
    cleanup();
    render(<CellEditorSlot field={fieldOf("checkbox")} value={null} {...spies()} />);
    expect(document.querySelector("input")).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("换字段类型就换编辑器：同一个槽位从数字换成星级", () => {
    const { rerender } = render(<CellEditorSlot field={fieldOf("number")} value={1} {...spies()} />);
    expect(screen.getByRole("spinbutton")).toBeTruthy();
    rerender(<CellEditorSlot field={fieldOf("rating")} value={1} {...spies()} />);
    expect(document.querySelector("input")).toBeNull();
    expect(document.querySelectorAll("button[title]")).toHaveLength(5);
  });

  it("未映射的类型落文本兜底：不炸，也不给占位以外的提示", () => {
    render(<CellEditorSlot field={fieldOf("formula")} value={null} {...spies()} />);
    const el = firstInput();
    expect(el.type).toBe("text");
    expect(el.placeholder).toBe("");
  });
});
