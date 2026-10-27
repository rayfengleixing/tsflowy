// @vitest-environment jsdom
// AI 答案的 Markdown 里，公式是整条链上唯一「类名当协议用」的地方：ai-math 把 TeX 换成
// <span class="ai-math-*"> 的占位节点，渲染层先按类名认出它是块级还是行内（components.span），
// 再在 KaTeX 出图前把同一个类名写回真正的 span（MathSpan）。这两处一旦用的是各写的字面量，
// 改常量名就会让「认得出、但渲染出来没类名」——CSS 与选择器同时落空，而纯逻辑测试看不见。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const katex = vi.hoisted(() => ({ renderTex: vi.fn() }));

vi.mock("@/lib/i18n", () => ({ t: (key: string) => key }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/katex-render", () => ({ renderTex: katex.renderTex }));
vi.mock("@/lib/mermaid-render", () => ({ renderMermaid: vi.fn() }));
vi.mock("@/lib/ipc-shell", () => ({ openUrl: vi.fn(() => Promise.resolve()) }));
vi.mock("@/lib/deep-link", () => ({ openRowInView: vi.fn() }));
vi.mock("@/lib/ai", () => ({ aiErrorText: (e: unknown) => String(e) }));

import { Markdown } from "./Markdown";
import { MATH_CLASS_BLOCK, MATH_CLASS_INLINE } from "./ai-math";

/** KaTeX 还没出图的那个状态：一条永不 resolve 的 Promise，界面停在 TeX 原文兜底 */
const PENDING: Promise<string> = new Promise<string>(() => undefined);

/** 渲染层回写的类名：占位节点与最终 span 都该是常量那两个字，不是各自抄一遍的字面量 */
function mathSpanIn(container: HTMLElement, cls: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`.${cls}`);
  if (!el) throw new Error(`渲染结果里没有类名为「${cls}」的公式 span`);
  return el;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => cleanup());

describe("Markdown 公式渲染：类名跟着常量走", () => {
  it("KaTeX 出图前，块级公式显示 TeX 原文并带 MATH_CLASS_BLOCK", () => {
    katex.renderTex.mockReturnValue(PENDING);
    const { container } = render(<Markdown text={"$$E=mc^2$$"} />);
    const el = mathSpanIn(container, MATH_CLASS_BLOCK);
    expect(el.textContent).toBe("E=mc^2");
    expect(el.tagName).toBe("SPAN");
  });

  it("行内公式不带类名（display 为假时故意不加，避免行内被撑成块）", () => {
    katex.renderTex.mockReturnValue(PENDING);
    const { container } = render(<Markdown text={"能理 $a+b$ 就行"} />);
    const el = screen.getByText("a+b");
    expect(el.className).toBe("");
    expect(el.tagName).toBe("SPAN");
    expect(container.querySelector(`.${MATH_CLASS_BLOCK}`)).toBeNull();
  });

  it("块级与行内分别按 displayMode 调 KaTeX，认类的是一条链而不是两处各判", async () => {
    katex.renderTex.mockResolvedValue("<i>rendered</i>");
    const first = render(<Markdown text={"$$B=1$$"} />);
    await waitFor(() => expect(katex.renderTex).toHaveBeenCalledWith("B=1", true));
    first.unmount();

    render(<Markdown text={"行内 $I=2$ 收尾"} />);
    await waitFor(() => expect(katex.renderTex).toHaveBeenCalledWith("I=2", false));
  });

  it("KaTeX 出图后，块级 span 仍是 MATH_CLASS_BLOCK，正文换成渲染结果", async () => {
    katex.renderTex.mockResolvedValue('<span class="katex">E=mc²</span>');
    const { container } = render(<Markdown text={"$$E=mc^2$$"} />);
    await waitFor(() => expect(container.querySelector(`.${MATH_CLASS_BLOCK} .katex`)).toBeTruthy());
    const el = mathSpanIn(container, MATH_CLASS_BLOCK);
    expect(el.className).toBe(MATH_CLASS_BLOCK);
    expect(el.textContent).toBe("E=mc²");
  });

  it("代码块里的 $ 不当公式：整段原样进 <code>，一次 KaTeX 都不调", () => {
    katex.renderTex.mockReturnValue(PENDING);
    const { container } = render(<Markdown text={'```\nprice = "$100"\n```'} />);
    expect(screen.getByText('price = "$100"').tagName).toBe("CODE");
    expect(katex.renderTex).not.toHaveBeenCalled();
    expect(container.querySelector(`.${MATH_CLASS_BLOCK}`)).toBeNull();
    expect(container.querySelector(`.${MATH_CLASS_INLINE}`)).toBeNull();
  });
});
