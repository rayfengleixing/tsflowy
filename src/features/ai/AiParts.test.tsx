// @vitest-environment jsdom
// AiParts 是 AiPanel / 气泡 / 输入区共用的三个小件，看着像纯样式，实际各有一条真判定：
// ImageThumb 的图片地址要异步解析（`assets/xxx.png` → asset 协议 URL），没解析出来时给的是占位灰底
// 而不是一个 src 空着的破图，而「换了一张图后上一张的迟到结果不许盖上来」全靠 effect 里那个 alive 标志；
// 删除按钮只在该给删除入口的地方出现（会话里已经发出去的图不许从气泡上删）；
// QuickButton 的 disabled 得真的点不动。
// 两处刻意没写成用例，理由是没有可观察行为：RowAction 的 `danger` 只多一个 hover class；ImageThumb 卸载后
// 那个 alive 挡住的是「对已卸载组件 setState」——React 19 既不报警也不留下任何 DOM 痕迹，删掉它看不出差别。
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

const assets = vi.hoisted(() => ({
  /**
   * 每次解析都留一个手动闸：谁先回来、什么时候回来由用例决定——
   * 「迟到的结果落不落地」这条判定只有控制 resolve 时机才断得出。
   */
  gates: [] as { resolve: (url: string) => void; reject: (err: unknown) => void }[],
  resolveAssetUrl: vi.fn(
    () =>
      new Promise<string>((resolve, reject) => {
        assets.gates.push({ resolve, reject });
      }),
  ),
}));
vi.mock("@/lib/assets/assets", () => ({ resolveAssetUrl: assets.resolveAssetUrl }));

import { ImageThumb, QuickButton, RowAction } from "./AiParts";

/** 缩略图的两态：解析出来的 img，或还没解析 / 解析失败的占位灰底 */
const imgOf = (c: HTMLElement) => c.querySelector("img");
const placeholderOf = (c: HTMLElement) =>
  Array.from(c.querySelectorAll("div")).find(
    (d) => d.className.includes("h-14") && d.className.includes("bg-neutral-100"),
  );

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

afterEach(() => {
  cleanup();
  assets.gates.length = 0;
  assets.resolveAssetUrl.mockClear();
});

describe("ImageThumb：图片地址是异步解析的", () => {
  it("URL 还没回来时是占位灰底，不是 src 空着的破图", async () => {
    const { container } = render(<ImageThumb path="assets/1.png" name="截图.png" />);
    await flush();
    expect(assets.resolveAssetUrl).toHaveBeenCalledWith("assets/1.png");
    expect(imgOf(container)).toBeNull();
    expect(placeholderOf(container)).toBeTruthy();
  });

  it("解析出来才换成 img，alt 与 title 都是附件名", async () => {
    const { container } = render(<ImageThumb path="assets/1.png" name="截图.png" />);
    assets.gates[0].resolve("http://asset.localhost/assets/1.png");
    await flush();
    expect(placeholderOf(container)).toBeUndefined();
    expect(imgOf(container)!.getAttribute("src")).toBe("http://asset.localhost/assets/1.png");
    expect(imgOf(container)!.getAttribute("alt")).toBe("截图.png");
    expect(imgOf(container)!.getAttribute("title")).toBe("截图.png");
  });

  it("解析失败继续留占位，不给一个加载不出来的破图", async () => {
    const { container } = render(<ImageThumb path="assets/1.png" name="截图.png" />);
    assets.gates[0].reject(new Error("asset 协议没起"));
    await flush();
    expect(imgOf(container)).toBeNull();
    expect(placeholderOf(container)).toBeTruthy();
  });

  it("换了一张图：上一张迟到的解析结果不许盖掉这一张", async () => {
    const { container, rerender } = render(<ImageThumb path="assets/1.png" name="第一张" />);
    rerender(<ImageThumb path="assets/2.png" name="第二张" />);
    expect(assets.gates).toHaveLength(2);
    assets.gates[1].resolve("http://asset.localhost/assets/2.png");
    await flush();
    expect(imgOf(container)!.getAttribute("src")).toBe("http://asset.localhost/assets/2.png");
    // 第一张的响应现在才到：那个 effect 已随 path 变化注销，这一次 setUrl 不该落地
    assets.gates[0].resolve("http://asset.localhost/assets/1.png");
    await flush();
    expect(imgOf(container)!.getAttribute("src")).toBe("http://asset.localhost/assets/2.png");
    expect(imgOf(container)!.getAttribute("alt")).toBe("第二张");
  });

  it("换了一张图：上一张迟到的解析失败也不许把这一张抹回占位", async () => {
    const { container, rerender } = render(<ImageThumb path="assets/1.png" name="第一张" />);
    rerender(<ImageThumb path="assets/2.png" name="第二张" />);
    assets.gates[1].resolve("http://asset.localhost/assets/2.png");
    await flush();
    expect(imgOf(container)!.getAttribute("src")).toBe("http://asset.localhost/assets/2.png");
    assets.gates[0].reject(new Error("第一张解析失败"));
    await flush();
    expect(imgOf(container)!.getAttribute("src")).toBe("http://asset.localhost/assets/2.png");
  });
});

describe("ImageThumb 的删除入口", () => {
  it("没有 onRemove 就不画删除按钮（会话里已发出的图不从气泡上删）", () => {
    const { container } = render(<ImageThumb path="assets/1.png" name="截图.png" />);
    expect(container.querySelector("button")).toBeNull();
  });

  it("给了 onRemove 才有那颗按钮，读屏叫得出名字，点一下只打一次", () => {
    const onRemove = vi.fn();
    const { container } = render(<ImageThumb path="assets/1.png" name="截图.png" onRemove={onRemove} />);
    const btn = container.querySelector("button")!;
    expect(btn.getAttribute("aria-label")).toBe("移除这张图片");
    fireEvent.click(btn);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});

describe("QuickButton 与 RowAction", () => {
  it("QuickButton 的 disabled 是真点不动，不是只淡一点", () => {
    const onClick = vi.fn();
    const { container, rerender } = render(<QuickButton icon={null} label="发送" disabled onClick={onClick} />);
    const btn = container.querySelector("button")!;
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
    rerender(<QuickButton icon={null} label="发送" disabled={false} onClick={onClick} />);
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("RowAction 那颗平时隐形的按钮，名字要挂在 aria-label 上而不只是 title", () => {
    const onClick = vi.fn();
    const { container } = render(<RowAction icon={null} label="删除会话" onClick={onClick} />);
    const btn = container.querySelector("button")!;
    expect(btn.getAttribute("aria-label")).toBe("删除会话");
    expect(btn.getAttribute("title")).toBe("删除会话");
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
