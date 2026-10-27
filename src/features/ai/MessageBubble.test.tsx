// @vitest-environment jsdom
// MessageBubble 从 AiPanel.tsx 搬出来时是「搬不改」，但搬的那一刻它把 AI 动作的整套判定收进了自己
// 这一层：卡片文案按「改文档」与「其它写动作」分岔、撤销按钮要看两套逆操作、哪几种动作值得弹 diff、
// 流式进行中消息级操作整排消失。这些都是「点错一下就动到文档」那一类，原来只能靠肉眼在原生窗口里看。
// 本文件刻意不 mock `@/lib/i18n`：detailText 那条「旧版本把裸 key 存进 detail」的路，
// 翻没翻只有真字典看得出差别——替身按 house style 原样返回 key 时，两条分支是同一个字符串。
// 也正因为用的是真字典，「待确认」那一档才改用英文钉：中文里两条分支恰好拼出同一句话（见下面那条用例）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AiActionRecord, AiMessage } from "@/stores/ai";
import { bindFakeApp, type FakeApp } from "@/test/app-fakes";
import { MessageBubble, type BubbleApi } from "./MessageBubble";

/** Markdown 与图片缩略图各有自己的用例，这里只关心气泡的判定；替身把真正喂进去的正文记下来 */
const mdSpy = vi.hoisted(() => ({ texts: [] as string[] }));
vi.mock("./Markdown", async () => {
  const React = await import("react");
  return {
    Markdown: ({ text }: { text?: string }) => {
      mdSpy.texts.push(text ?? "");
      return React.createElement("div", { "data-testid": "md" }, text ?? "");
    },
  };
});
vi.mock("./AiParts", async () => {
  const React = await import("react");
  return { ImageThumb: ({ path }: { path: string }) => React.createElement("img", { alt: path }) };
});

const apiOf = (): BubbleApi => ({
  copy: vi.fn(),
  regenerate: vi.fn(),
  edit: vi.fn(),
  savePage: vi.fn(),
  exportMsg: vi.fn(),
  branch: vi.fn(),
  rate: vi.fn(),
  writeBack: vi.fn(),
  undo: vi.fn(),
  apply: vi.fn(),
  reject: vi.fn(),
  viewDiff: vi.fn(),
});

const actionOf = (over: Partial<AiActionRecord> = {}): AiActionRecord => ({
  tool: "apply_edit",
  call: null,
  op: null,
  summary: "把第三段改短",
  content: "改后的正文",
  before: "改前的正文",
  state: "pending",
  ...over,
});

const msgOf = (over: Partial<AiMessage> = {}): AiMessage => ({
  id: "m1",
  role: "assistant",
  content: "回答正文",
  ...over,
});

const one = (message: AiMessage, opts: { busy?: boolean } = {}) => {
  const api = apiOf();
  const { container } = render(<MessageBubble message={message} busy={opts.busy} api={api} />);
  return { api, container, message };
};

/** 卡片那一行的整段文案：状态 + 「：说明」+ 「（结果/原因）」拼在同一个 span 里 */
function cardText(container: HTMLElement, index = 0): string {
  const list = Array.from(container.querySelectorAll("span.min-w-0"));
  if (list.length <= index) throw new Error(`第 ${index + 1} 张动作卡片没渲染出来，实际只有 ${list.length} 张`);
  return list[index].textContent ?? "";
}

const btn = (label: string) => screen.queryByRole("button", { name: label });

/** 只有换语言那条用例需要绑假运行态；统一在 afterEach 里解绑，免得脏语言留给后面的用例 */
let app: FakeApp | null = null;

afterEach(() => {
  cleanup();
  mdSpy.texts.length = 0;
  app?.dispose();
  app = null;
});

describe("动作卡片的状态文案：改文档与其它写动作各一套", () => {
  it("待确认：改文档用整句话，其它动作把动作名插进句子里", () => {
    const { container, rerender } = render(<MessageBubble message={msgOf({ actions: [actionOf()] })} api={apiOf()} />);
    expect(cardText(container)).toBe("待确认：AI 建议修改文档：把第三段改短");
    rerender(
      <MessageBubble
        message={msgOf({ actions: [actionOf({ tool: "create_page", summary: "新建「周报」" })] })}
        api={apiOf()}
      />,
    );
    expect(cardText(container)).toBe("待确认：AI 建议新建页面：新建「周报」");
  });

  // 「待确认」这一档两条分支在中文里恰好拼出同一句话（`ai.actionPending` 的 {name} 就是「修改文档」），
  // 所以上面那条抓不到「分岔失效」；已应用与已忽略两档的措辞是真的不一样，分岔要在这些地方钉。
  it("同一个状态在「改文档」与「其它动作」上是两句话：已应用与已忽略各一套", () => {
    const cases: [string, AiActionRecord, string][] = [
      ["改文档·已应用", actionOf({ state: "applied", summary: "" }), "已修改文档"],
      ["建页·已应用", actionOf({ state: "applied", tool: "create_page", summary: "" }), "新建页面已完成"],
      ["改文档·已忽略", actionOf({ state: "rejected", summary: "" }), "已忽略本次修改建议"],
      ["建页·已忽略", actionOf({ state: "rejected", tool: "create_page", summary: "" }), "已忽略新建页面建议"],
      ["改文档·没写成", actionOf({ state: "unavailable", summary: "" }), "未写入文档（当前没有可编辑的文档）"],
      ["建页·没写成", actionOf({ state: "unavailable", tool: "create_page", summary: "" }), "未执行：新建页面"],
    ];
    for (const [, rec, expected] of cases) {
      const { unmount, container } = render(<MessageBubble message={msgOf({ actions: [rec] })} api={apiOf()} />);
      expect(cardText(container)).toBe(expected);
      unmount();
      cleanup();
    }
  });

  // 中文里「AI 建议修改文档」与「AI 建议{修改文档}」拼出同一句话，这一档的分岔在 zh 下断不出（R 批记为不可观察）。
  // 换到英文就断得出：isEdit 那句带冠词（"a document change"），插 {name} 那条只会得到 "document change"。
  // 语言是 app-context 的读值，绑一棵假运行态就切得过去——字典与产品代码都不动；「：」是卡片硬编码的分隔符，两种语言都在。
  it("「待确认」的分岔只有换到英文才断得出：改文档那句带冠词", () => {
    app = bindFakeApp({ lang: "en-US" });
    const { container, rerender } = render(
      <MessageBubble message={msgOf({ actions: [actionOf({ summary: "shorten" })] })} api={apiOf()} />,
    );
    expect(cardText(container)).toBe("Pending: the AI suggests a document change：shorten");
    rerender(
      <MessageBubble
        message={msgOf({ actions: [actionOf({ tool: "create_page", summary: "weekly" })] })}
        api={apiOf()}
      />,
    );
    expect(cardText(container)).toBe("Pending: the AI suggests page creation：weekly");
  });

  it("已撤销压过已应用：undone 的卡片说「已撤销本次修改」", () => {
    const { container } = render(
      <MessageBubble
        message={msgOf({ actions: [actionOf({ state: "applied", undone: true, summary: "" })] })}
        api={apiOf()}
      />,
    );
    expect(cardText(container)).toBe("已撤销本次修改");
  });

  it("指令格式有误：不给 summary 后缀，也不给「查看改动」", () => {
    const { container } = render(
      <MessageBubble
        message={msgOf({ actions: [actionOf({ state: "malformed", tool: "invalid", content: "", before: "" })] })}
        api={apiOf()}
      />,
    );
    expect(cardText(container)).not.toContain("把第三段改短");
    expect(btn("查看改动")).toBeNull();
  });

  it("detail 里的旧版裸 key 翻成人话，翻不到的原样显示", () => {
    const { container, rerender } = render(
      <MessageBubble
        message={msgOf({ actions: [actionOf({ state: "unavailable", detail: "ai.locateTextNotFound" })] })}
        api={apiOf()}
      />,
    );
    expect(cardText(container)).toContain("（没找到要替换的原文，未修改文档）");
    rerender(
      <MessageBubble
        message={msgOf({ actions: [actionOf({ state: "unavailable", detail: "表行已经不存在了" })] })}
        api={apiOf()}
      />,
    );
    expect(cardText(container)).toContain("（表行已经不存在了）");
  });
});

describe("动作卡片的按钮闸门：哪一张能被点", () => {
  it("只有待确认的卡片给「应用」和「忽略」，点击带上是第几张", () => {
    const { api } = one(
      msgOf({
        actions: [actionOf({ state: "applied", summary: "第一张" }), actionOf({ summary: "第二张" })],
      }),
    );
    expect(btn("应用")).toBeTruthy();
    fireEvent.click(btn("忽略")!);
    fireEvent.click(btn("应用")!);
    expect(api.reject).toHaveBeenCalledTimes(1);
    // 第一张是已应用、第二张才是待确认：索引必须落到 1
    expect(api.reject).toHaveBeenCalledWith("m1", 1);
    expect(api.apply).toHaveBeenCalledWith("m1", 1);
  });

  it("已应用且有逆操作才出「撤销」；两套都没有就不给（建页卡片重启后不可一键回滚）", () => {
    const { rerender } = render(
      <MessageBubble
        message={msgOf({ actions: [actionOf({ state: "applied", revert: { before: null } })] })}
        api={apiOf()}
      />,
    );
    expect(btn("撤销")).toBeTruthy();
    rerender(
      <MessageBubble
        message={msgOf({
          actions: [actionOf({ state: "applied", tool: "create_page", undo: { kind: "remove_view", view_id: "v1" } })],
        })}
        api={apiOf()}
      />,
    );
    expect(btn("撤销")).toBeTruthy();
    rerender(<MessageBubble message={msgOf({ actions: [actionOf({ state: "applied" })] })} api={apiOf()} />);
    expect(btn("撤销")).toBeNull();
    rerender(
      <MessageBubble
        message={msgOf({ actions: [actionOf({ state: "applied", undone: true, revert: { before: null } })] })}
        api={apiOf()}
      />,
    );
    expect(btn("撤销")).toBeNull();
  });

  it("「查看改动」只给看得出差别的动作：改文档要有正文或原文、建页要有正文、改标题不给", () => {
    const cases: [string, Partial<AiActionRecord>, boolean][] = [
      ["改文档有正文", { state: "applied" }, true],
      ["改文档只剩原文（删干净了）", { state: "applied", content: "   ", before: "旧的" }, true],
      ["改文档两边都空", { state: "applied", content: "", before: "" }, false],
      ["建页有正文", { state: "applied", tool: "create_page", content: "# 周报" }, true],
      ["建页正文空白", { state: "applied", tool: "create_page", content: "  " }, false],
      ["改标题只有一句话说明", { state: "applied", tool: "set_page_title", content: "周报" }, false],
      ["被忽略的改文档", { state: "rejected", content: "改后的正文" }, false],
    ];
    for (const [, over, expected] of cases) {
      const { unmount } = render(<MessageBubble message={msgOf({ actions: [actionOf(over)] })} api={apiOf()} />);
      expect(Boolean(btn("查看改动"))).toBe(expected);
      unmount();
      cleanup();
    }
  });

  it("点「查看改动」把这张卡片原样交给父层弹 diff", () => {
    const rec = actionOf({ state: "applied" });
    const { api } = one(msgOf({ actions: [rec] }));
    fireEvent.click(btn("查看改动")!);
    expect(api.viewDiff).toHaveBeenCalledWith("m1", 0, rec);
  });
});

describe("气泡与消息级操作", () => {
  it("正文与首张卡片的说明是同一句话时不重复渲染气泡，回写那一排也一并让位", () => {
    one(msgOf({ content: "已建页", actions: [actionOf({ summary: "已建页" })] }));
    expect(screen.queryByTestId("md")).toBeNull();
    expect(screen.queryAllByTitle("替换选中")).toHaveLength(0);
    expect(mdSpy.texts).toEqual([]);
  });

  // 本文件把 ./Markdown 换成了替身（钉的是「喂进去的是哪段正文、喂了几次」），记号真被解析成标签的另一半
  // 证据在 MessageBubble.markdown.test.tsx——那条用**真** Markdown 渲染，两边合起来才接得住这条接缝。
  it("交给 Markdown 的就是正文那一段：不拼卡片说明，也只交一次", () => {
    one(msgOf({ content: "**加粗** 的正文", actions: [actionOf({ summary: "把第三段改短" })] }));
    expect(mdSpy.texts).toEqual(["**加粗** 的正文"]);
  });

  it("回写编辑器用的是整条正文，插入与替换两种模式各打一次", () => {
    const { api } = one(msgOf({ content: "第一段\n第二段" }));
    fireEvent.click(screen.getByTitle("替换选中"));
    fireEvent.click(screen.getByTitle("插入到光标处"));
    expect(api.writeBack).toHaveBeenNthCalledWith(1, "第一段\n第二段", "replace");
    expect(api.writeBack).toHaveBeenNthCalledWith(2, "第一段\n第二段", "insert");
  });

  it("空气泡的助手回复也要有个「…」占位，不渲染成空白一条", () => {
    one(msgOf({ content: "" }));
    expect(screen.getByTestId("md").textContent).toBe("…");
  });

  it("流式进行中整排消息级操作消失，但待确认卡片的「应用」还在", () => {
    const { container } = one(msgOf({ actions: [actionOf()] }), { busy: true });
    expect(btn("复制这条")).toBeNull();
    expect(btn("从此处重新生成")).toBeNull();
    expect(btn("应用")).toBeTruthy();
    expect(container.textContent).toContain("待确认：AI 建议修改文档");
  });

  it("提问与回答的操作集不一样：回答能重新生成与存页，提问只能改这条", () => {
    one(msgOf({ role: "user", content: "帮我把第三段改短" }));
    expect(btn("改这条提问")).toBeTruthy();
    expect(btn("复制这条")).toBeTruthy();
    expect(btn("从此处重新生成")).toBeNull();
    expect(btn("存为页面")).toBeNull();
    expect(btn("导出为 Markdown")).toBeNull();
    expect(btn("这个回答有用")).toBeNull();
    expect(screen.queryAllByTitle("替换选中")).toHaveLength(0);
  });

  it("评过分的回答把那一侧标成按下，另一侧没按下", () => {
    const { api } = one(msgOf({ rating: "down" }));
    expect(btn("这个回答不行")!.getAttribute("aria-pressed")).toBe("true");
    expect(btn("这个回答有用")!.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(btn("这个回答有用")!);
    expect(api.rate).toHaveBeenCalledWith("m1", "up");
  });

  it("提问带的图片排在气泡之外，一张不落", () => {
    one(
      msgOf({
        role: "user",
        content: "看这张图",
        images: [
          { name: "a.png", path: "assets/1.png" },
          { name: "b.png", path: "assets/2.png" },
        ],
      }),
    );
    expect(screen.getByAltText("assets/1.png")).toBeTruthy();
    expect(screen.getByAltText("assets/2.png")).toBeTruthy();
  });
});
