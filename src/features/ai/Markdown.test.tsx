// @vitest-environment jsdom
// AI 答案的 Markdown 里，公式是整条链上唯一「类名当协议用」的地方：ai-math 把 TeX 换成
// <span class="ai-math-*"> 的占位节点，渲染层先按类名认出它是块级还是行内（components.span），
// 再在 KaTeX 出图前把同一个类名写回真正的 span（MathSpan）。这两处一旦用的是各写的字面量，
// 改常量名就会让「认得出、但渲染出来没类名」——CSS 与选择器同时落空，而纯逻辑测试看不见。
// 同一个渲染层里另一条异步兜底是 mermaid 围栏：出图前后都退回源码、失败才给提示，而它是
// 「等笔停 350ms 再画」的防抖形状，只有假计时器能看出半截语法那一帧根本没去画。
// 这批之后还钉了两件事：代码块的按需高亮（语言没注册就退回纯文本，正文一个字不许丢）与链接的
// 分岔（引用链接只跳站内、外链只交系统浏览器——两边都不许让 WebView2 整页跳走）。
// 再往下列的是「界面对了但包胖了」那一族：high.js 那几百 KB 靠 `??= import(…)` 只在答案真出现代码块
// 时进来一次，改回静态引入界面一模一样、只有加载次数看得出来；以及高亮抛异常时要退回**当前**正文的
// 纯文本，残留上一版着色在流式里看不出来、只有换正文那一帧能看出来。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { bindFakeApp } from "@/test/app-fakes";
import { viewNode } from "@/test/view-node";

const katex = vi.hoisted(() => ({ renderTex: vi.fn() }));
const mermaid = vi.hoisted(() => ({ renderMermaid: vi.fn<(code: string) => Promise<string>>() }));
/** 跳转的两个出口做成可断言的替身：引用链接与外链各走一边，走错一边就是「站内页被浏览器接管」 */
const nav = vi.hoisted(() => ({ openRowInView: vi.fn(), openUrl: vi.fn(() => Promise.resolve()) }));
const toaster = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
/**
 * lowlight 替身：只认 "ts" 这一种语言，highlight 产出真实 lowlight 会出现的那两类 hast 节点
 * （element + text），类名带上语言名好让用例点名查。
 */
const hl = vi.hoisted(() => ({
  /** `@/lib/code-highlight` 这个模块被求值过几次：几百 KB 的 high.js 只该在答案真出现代码块时进来一次 */
  imports: 0,
  registered: vi.fn((lang: string) => lang === "ts"),
  highlight: vi.fn((lang: string, code: string) => ({
    children: [
      {
        type: "element",
        tagName: "span",
        properties: { className: [`hljs-${lang}`] },
        children: [{ type: "text", value: code }],
      },
    ],
  })),
}));

vi.mock("@/lib/i18n", () => ({ t: (key: string) => key }));
vi.mock("sonner", () => ({ toast: toaster }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/render/katex-render", () => ({ renderTex: katex.renderTex }));
vi.mock("@/lib/render/mermaid-render", () => ({ renderMermaid: mermaid.renderMermaid }));
vi.mock("@/lib/ipc/ipc-shell", () => ({ openUrl: nav.openUrl }));
vi.mock("@/lib/desktop/deep-link", () => ({ openRowInView: nav.openRowInView }));
vi.mock("@/lib/ai", () => ({ aiErrorText: (e: unknown) => String(e) }));
vi.mock("@/lib/render/code-highlight", () => ({
  // 数的是「取了几次这个导出」，不是「工厂跑了几次」——vi.resetModules() 不重放 mock 工厂，
  // 而 `??= import(…).then((m) => m.lowlight)` 每份 Markdown 模块只可能取一次，正好是缓存的代理。
  get lowlight() {
    hl.imports += 1;
    return hl;
  },
}));

import { Markdown } from "./Markdown";
import { MATH_CLASS_BLOCK, MATH_CLASS_INLINE } from "./ai-math";

// 引用链接的标题要在页面树里解析得到（解析不到就留原样文本），所以本文件也得绑一棵假树
bindFakeApp({ workspaceId: "w1", tree: [viewNode("v1", "周报")] });

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

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

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

describe("Markdown mermaid 围栏：等笔停才画，出图前后都退回源码", () => {
  const fence = (code: string) => "```mermaid\n" + code + "\n```";
  const FAIL_HINT = "ai.mermaidRenderFailed";

  it("刚写下的半截语法不去画：350ms 内一次 renderMermaid 都不调，界面只有源码", () => {
    vi.useFakeTimers();
    mermaid.renderMermaid.mockReturnValue(PENDING);
    const { container } = render(<Markdown text={fence("graph TD; A-->")} />);
    vi.advanceTimersByTime(349);
    expect(mermaid.renderMermaid).not.toHaveBeenCalled();
    expect(screen.getByText("graph TD; A-->").tagName).toBe("CODE");
    expect(container.textContent).not.toContain(FAIL_HINT);
  });

  it("流式增量只按最后停下的那份文本画一次", () => {
    vi.useFakeTimers();
    mermaid.renderMermaid.mockReturnValue(PENDING);
    const { rerender } = render(<Markdown text={fence("graph TD; A-->")} />);
    vi.advanceTimersByTime(200);
    rerender(<Markdown text={fence("graph TD; A-->B")} />);
    vi.advanceTimersByTime(200);
    expect(mermaid.renderMermaid).not.toHaveBeenCalled();
    vi.advanceTimersByTime(350);
    expect(mermaid.renderMermaid).toHaveBeenCalledTimes(1);
    expect((mermaid.renderMermaid.mock.calls[0]?.[0] ?? "").trim()).toBe("graph TD; A-->B");
  });

  it("画成：源码整块换成图，不出现失败提示", async () => {
    vi.useFakeTimers();
    mermaid.renderMermaid.mockResolvedValue('<svg data-mermaid="ok"><path /></svg>');
    const { container } = render(<Markdown text={fence("graph TD; A-->B")} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });
    expect(container.querySelector('svg[data-mermaid="ok"]')).toBeTruthy();
    expect(screen.queryByText("graph TD; A-->B")).toBeNull();
    expect(container.textContent).not.toContain(FAIL_HINT);
  });

  it("画失败：退回源码并给提示", async () => {
    vi.useFakeTimers();
    mermaid.renderMermaid.mockRejectedValue(new Error("语法错了"));
    const { container } = render(<Markdown text={fence("graph TD; A-->B")} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });
    expect(screen.getByText("graph TD; A-->B").tagName).toBe("CODE");
    expect(container.textContent).toContain(FAIL_HINT);
  });

  it("先画成功、再改正文改失败：失败态压掉旧图，退回新源码并给提示", async () => {
    vi.useFakeTimers();
    mermaid.renderMermaid.mockResolvedValueOnce('<svg data-mermaid="one" />');
    mermaid.renderMermaid.mockRejectedValueOnce(new Error("语法错了"));
    const { rerender, container } = render(<Markdown text={fence("graph TD; A-->B")} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });
    expect(container.querySelector('svg[data-mermaid="one"]')).toBeTruthy();

    rerender(<Markdown text={fence("graph TD; A-->[B")} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });
    expect(container.querySelector("svg")).toBeNull();
    expect(screen.getByText("graph TD; A-->[B").tagName).toBe("CODE");
    expect(container.textContent).toContain(FAIL_HINT);
  });

  it("改坏了再改回来：画成功后提示撤掉，源码让位给新图", async () => {
    vi.useFakeTimers();
    mermaid.renderMermaid.mockRejectedValueOnce(new Error("语法错了"));
    mermaid.renderMermaid.mockResolvedValueOnce('<svg data-mermaid="fixed" />');
    const { rerender, container } = render(<Markdown text={fence("graph TD; A-->[B")} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });
    expect(container.textContent).toContain(FAIL_HINT);

    rerender(<Markdown text={fence("graph TD; A-->B")} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });
    expect(container.querySelector('svg[data-mermaid="fixed"]')).toBeTruthy();
    expect(container.textContent).not.toContain(FAIL_HINT);
    expect(screen.queryByText("graph TD; A-->B")).toBeNull();
  });

  it("正文还没写（空围栏）不调渲染器，也不报失败", () => {
    vi.useFakeTimers();
    mermaid.renderMermaid.mockResolvedValue('<svg data-mermaid="never" />');
    const { container } = render(<Markdown text={"```mermaid\n```"} />);
    vi.advanceTimersByTime(400);
    expect(mermaid.renderMermaid).not.toHaveBeenCalled();
    expect(container.querySelector("svg")).toBeNull();
    expect(container.textContent).not.toContain(FAIL_HINT);
  });

  it("换了正文，上一半截那次的迟到结果不落地", async () => {
    vi.useFakeTimers();
    let resolveFirst: ((svg: string) => void) | undefined;
    mermaid.renderMermaid.mockImplementationOnce(
      () =>
        new Promise<string>((r) => {
          resolveFirst = r;
        }),
    );
    mermaid.renderMermaid.mockResolvedValue('<svg data-mermaid="second" />');
    const { rerender, container } = render(<Markdown text={fence("graph TD; A-->")} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });
    rerender(<Markdown text={fence("graph TD; A-->B")} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });
    await act(async () => {
      resolveFirst?.('<svg data-mermaid="stale" />');
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(container.querySelector('svg[data-mermaid="stale"]')).toBeNull();
    expect(container.querySelector('svg[data-mermaid="second"]')).toBeTruthy();
  });
});

// 高亮那几百 KB 是按需拉的，拉回来只做一件事：语言注册过就把 lowlight 的 hast 换成带类名的 span，
// 没注册（模型臆造的别名）一律退回纯文本。两种形态给用户的正文必须一模一样——丢字符比不高亮严重得多。
describe("Markdown 代码块高亮：注册过的语言才上色，认不出就原样", () => {
  const codeFence = (lang: string, body: string) => "```" + lang + "\n" + body + "\n```";
  const bodyText = (container: HTMLElement) => container.querySelector("code")?.textContent?.trim();

  it("注册过的语言出带类名的高亮节点，正文一个字不丢", async () => {
    const { container } = render(<Markdown text={codeFence("ts", "const a = 1;")} />);
    await waitFor(() => expect(container.querySelector("span.hljs-ts")).toBeTruthy());
    expect(hl.highlight).toHaveBeenCalledWith("ts", expect.stringContaining("const a = 1;"));
    // 高亮是「同一份文本换进带类名的 span」，不是重写：外层 <code> 读出来还得是原正文
    expect(bodyText(container)).toBe("const a = 1;");
  });

  it("模型臆造的语言别名退回纯文本，且一次 highlight 都不调（不做自动嗅探）", async () => {
    const { container } = render(<Markdown text={codeFence("typescriptx", "x = 1")} />);
    await waitFor(() => expect(hl.registered).toHaveBeenCalledWith("typescriptx"));
    expect(hl.highlight).not.toHaveBeenCalled();
    expect(container.querySelector("span")).toBeNull();
    expect(bodyText(container)).toBe("x = 1");
  });

  it("流式里正文接着写：按新正文再高亮一次，界面上留的不是旧文本", async () => {
    const { rerender, container } = render(<Markdown text={codeFence("ts", "第一版")} />);
    await waitFor(() => expect(container.querySelector("span.hljs-ts")?.textContent).toBe("第一版\n"));
    rerender(<Markdown text={codeFence("ts", "第二版")} />);
    await waitFor(() => expect(hl.highlight).toHaveBeenCalledTimes(2));
    expect(container.querySelector("span.hljs-ts")?.textContent).toBe("第二版\n");
    expect(bodyText(container)).toBe("第二版");
  });

  it("包还没到位那一帧就是纯文本：渲染不挂在加载上", () => {
    // 同步返回的 render 里 effect 已跑过，`import()` 的 then 还在微任务队列——这一帧必须读得到正文
    const { container } = render(<Markdown text={codeFence("ts", "const a = 1;")} />);
    expect(hl.registered).not.toHaveBeenCalled();
    expect(container.querySelector("span")).toBeNull();
    expect(bodyText(container)).toBe("const a = 1;");
  });

  it("高亮这一步抛异常：退回当前正文的纯文本，不残留上一版的着色", async () => {
    const { rerender, container } = render(<Markdown text={codeFence("ts", "第一版")} />);
    await waitFor(() => expect(container.querySelector("span.hljs-ts")?.textContent).toBe("第一版\n"));
    hl.highlight.mockImplementationOnce(() => {
      throw new Error("high.js 内部炸了");
    });
    rerender(<Markdown text={codeFence("ts", "第二版")} />);
    await waitFor(() => expect(hl.highlight).toHaveBeenCalledTimes(2));
    expect(container.querySelector("span")).toBeNull();
    expect(bodyText(container)).toBe("第二版");
  });
});

// `Markdown.tsx:20` 的 `lowlightPromise ??= import(…)` 是「几百 KB 按需进来一次」的唯一守卫：
// 改回静态引入，主包当场胖回去，而界面一模一样、纯逻辑测试全绿。所以这里查的是模块被求值的次数。
describe("Markdown 的高亮包是按需加载、且只加载一次", () => {
  const fence = (lang: string, body: string) => "```" + lang + "\n" + body + "\n```";

  it("答案里没有代码块就不加载；有代码块时几个围栏也只加载一次", async () => {
    vi.resetModules();
    hl.imports = 0;
    const { Markdown: Fresh } = await import("./Markdown");
    render(<Fresh text="只有正文，没有围栏。" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(hl.imports).toBe(0);

    const { container } = render(<Fresh text={`${fence("ts", "const a = 1;")}\n\n${fence("ts", "const b = 2;")}`} />);
    await waitFor(() => expect(hl.registered).toHaveBeenCalled());
    expect(hl.imports).toBe(1);
    expect(container.querySelectorAll("span.hljs-ts")).toHaveLength(2);
  });
});

// 引用链接与外链的分岔是这条链上唯一「点一下就换地方」的口子：答案出自模型，链接文字与 href
// 都算不可信输入，所以站内跳转绝不能被当成 http 交出去，外链也不能让 WebView2 整页跳走。
describe("Markdown 链接分岔：引用跳站内，外链交系统浏览器", () => {
  it("答案里的 [id=v1] 变成站内引用链接，点击只跳页面、不碰系统浏览器", () => {
    render(<Markdown text={"结论见 [id=v1]。"} />);
    const link = screen.getByTitle("ai.citationOpen");
    expect(link.tagName).toBe("A");
    // 站内引用用的是相对形态的 href：自定义协议会被 react-markdown 的默认清洗剥掉，链接就点不动了
    expect(link.getAttribute("href")).toBe("tsflowy-citation/v1");
    expect(link.textContent).toBe("周报");
    // fireEvent.click 返回「默认动作是否没被阻止」：false 才是拦住了整页跳转
    expect(fireEvent.click(link)).toBe(false);
    expect(nav.openRowInView).toHaveBeenCalledWith("v1");
    expect(nav.openUrl).not.toHaveBeenCalled();
  });

  it("指向不存在页面的 [id=…] 留成原样文本，不造一个点不动的假链接", () => {
    const { container } = render(<Markdown text={"见 [id=ghost]。"} />);
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe("见 [id=ghost]。");
  });

  it("代码块里的 [id=v1] 是源码不是正文，不换成链接", async () => {
    const { container } = render(<Markdown text={'```ts\nconst who = "[id=v1]";\n```'} />);
    await waitFor(() => expect(container.querySelector("span.hljs-ts")).toBeTruthy());
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("code")?.textContent).toContain("[id=v1]");
  });

  it("普通外链交给系统浏览器，标签上带着 noopener，站内跳转不掺和", () => {
    const { container } = render(<Markdown text={"看 [官网](https://example.com)"} />);
    const link = container.querySelector("a");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(fireEvent.click(link as HTMLElement)).toBe(false);
    expect(nav.openUrl).toHaveBeenCalledWith("https://example.com");
    expect(nav.openRowInView).not.toHaveBeenCalled();
  });

  it("模型写的裸 URL 自动成外链：一样走 openUrl、一样带 noopener，不是让 WebView2 接管", () => {
    const { container } = render(<Markdown text={"详见 https://example.com/a?b=1 这一页"} />);
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://example.com/a?b=1");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(fireEvent.click(link as HTMLElement)).toBe(false);
    expect(nav.openUrl).toHaveBeenCalledWith("https://example.com/a?b=1");
  });

  it("模型写的删除线成 del，不成一对波浪号原文", () => {
    const { container } = render(<Markdown text={"这段 ~~作废了~~ 留着"} />);
    expect(container.querySelector("del")?.textContent).toBe("作废了");
    expect(container.textContent).not.toContain("~~");
  });

  it("外链打开失败：错误文案进 toast，不是点了一下没反应", async () => {
    nav.openUrl.mockRejectedValueOnce(new Error("没有可用的浏览器"));
    render(<Markdown text={"看 [官网](https://bad.example)"} />);
    fireEvent.click(screen.getByText("官网"));
    await waitFor(() => expect(toaster.error).toHaveBeenCalledWith(expect.stringContaining("没有可用的浏览器")));
  });

  it("GFM 生效：模型给的表格成表格、任务列表成勾选框，不是竖线和方括号原文", () => {
    const { container } = render(
      <Markdown text={"| 项目 | 状态 |\n| --- | --- |\n| 周报 | 进行中 |\n\n- [x] 已发\n- [ ] 待发"} />,
    );
    expect(container.querySelectorAll("th")).toHaveLength(2);
    expect(container.querySelector("tbody td")?.textContent).toBe("周报");
    const boxes = Array.from(container.querySelectorAll<HTMLInputElement>("input[type=checkbox]"));
    expect(boxes.map((b) => b.checked)).toEqual([true, false]);
    expect(container.textContent).not.toContain("| --- |");
  });
});
