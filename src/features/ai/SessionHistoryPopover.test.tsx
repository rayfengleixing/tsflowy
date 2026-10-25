// @vitest-environment jsdom
// 历史会话弹层从 AiPanel.tsx 切出来时是「搬不改」，但切出来的那一刻它第一次能被单独渲染：
// 这几条钉住的正是这次搬动可能碰坏的东西——四份输入态收进了组件自己（搜索/分区/改名），
// 收起要回到宿主的 showHistory（onClose），删除必须只把 id 递给宿主的确认框（onRequestDelete），
// 以及「加载更多」只在超出显示窗口时的最近分区出现。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { SessionHistoryPopover } from "./SessionHistoryPopover";
import { useAiStore } from "@/stores/ai";
import type { StoredSession } from "@/stores/ai";

vi.mock("@/lib/i18n", () => ({
  t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
}));

const ai = vi.hoisted(() => ({
  switchSession: vi.fn(),
  renameSession: vi.fn(),
  setSessionArchived: vi.fn(),
  loadMoreSessions: vi.fn(),
}));

vi.mock("@/stores/ai", async () => {
  const { create } = await import("zustand");
  const store = create(() => ({
    sessions: [] as unknown[],
    sessionsShown: 20,
    switchSession: ai.switchSession,
    renameSession: ai.renameSession,
    setSessionArchived: ai.setSessionArchived,
    loadMoreSessions: ai.loadMoreSessions,
  }));
  return {
    useAiStore: store,
    // 真实现是「归档全留 + 最近 N 条普通会话」，这里按显示窗口截断即可：用例只关心超没超窗口
    visibleSessionWindow: (list: unknown[], shown: number) => list.slice(0, shown),
  };
});

const sessionOf = (id: string, title: string, extra: Partial<StoredSession> = {}): StoredSession => ({
  id,
  title,
  updatedAt: 0,
  messages: [{ id: `${id}-m`, role: "user", content: `${title} 的正文` }],
  ...extra,
});

function mount(props: { onClose?: () => void; onRequestDelete?: (id: string) => void } = {}) {
  const onClose = props.onClose ?? vi.fn();
  const onRequestDelete = props.onRequestDelete ?? vi.fn();
  render(<SessionHistoryPopover onClose={onClose} onRequestDelete={onRequestDelete} />);
  return { onClose, onRequestDelete };
}

// 会话行的可及名就是标题（标题后面可能紧跟来源页）；右侧三个悬浮操作的name是 i18n key，不会误命中
const rows = () => screen.queryAllByRole("button", { name: /周报|月报|日报|旧闻|复盘/ });

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  useAiStore.setState({ sessions: [], sessionsShown: 20 });
});

describe("SessionHistoryPopover", () => {
  it("搜索词按标题与正文筛：留下的正是匹配的那条", () => {
    useAiStore.setState({
      sessions: [sessionOf("s-1", "周报"), sessionOf("s-2", "月度复盘", { pageTitle: "文档" })],
    });
    mount();
    fireEvent.change(screen.getByRole("textbox", { name: "ai.searchSessions" }), {
      target: { value: "复盘" },
    });
    expect(rows().map((b) => b.textContent)).toEqual(["月度复盘· 文档"]);
  });

  it("分区切换：归档页只列归档会话，页签上的计数是全量", () => {
    useAiStore.setState({
      sessions: [
        sessionOf("s-1", "周报"),
        sessionOf("s-2", "旧闻", { archived: true }),
        sessionOf("s-3", "陈年旧闻", { archived: true }),
      ],
    });
    mount();
    expect(screen.getByText("ai.historyArchivedTab · 2")).toBeTruthy();
    fireEvent.click(screen.getByText("ai.historyRecentTab"));
    expect(rows().map((b) => b.textContent)).toEqual(["周报"]);
    fireEvent.click(screen.getByText("ai.historyArchivedTab · 2"));
    expect(rows().map((b) => b.textContent)).toEqual(["旧闻", "陈年旧闻"]);
  });

  it("点会话名：切过去并收起（收起走宿主的 onClose）", () => {
    useAiStore.setState({ sessions: [sessionOf("s-1", "周报")] });
    const { onClose } = mount();
    fireEvent.click(screen.getByRole("button", { name: /^周报/ }));
    expect(ai.switchSession).toHaveBeenCalledWith("s-1");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("改名：铅笔进编辑态，Enter 提交 renameSession，Escape 只退出", () => {
    useAiStore.setState({ sessions: [sessionOf("s-1", "周报")] });
    mount();
    fireEvent.click(screen.getByTitle("ai.renameSession"));
    const field = screen.getByRole("textbox", { name: "ai.renameSessionField" });
    fireEvent.change(field, { target: { value: "周报（改）" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(ai.renameSession).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "ai.renameSessionField" })).toBeNull();
    // Escape 退出编辑态后行按钮回来了；会话标题仍是旧的（没落库）
    expect(rows().map((b) => b.textContent)).toEqual(["周报"]);

    fireEvent.click(screen.getByTitle("ai.renameSession"));
    const field2 = screen.getByRole("textbox", { name: "ai.renameSessionField" });
    fireEvent.change(field2, { target: { value: "周报（改）" } });
    fireEvent.keyDown(field2, { key: "Enter" });
    expect(ai.renameSession).toHaveBeenCalledWith("s-1", "周报（改）");
  });

  it("删除只把 id 递给宿主确认框，组件自己不动会话数据", () => {
    useAiStore.setState({ sessions: [sessionOf("s-1", "周报"), sessionOf("s-2", "月报")] });
    const { onRequestDelete } = mount();
    fireEvent.click(screen.getAllByTitle("ai.deleteSession")[0]);
    expect(onRequestDelete).toHaveBeenCalledWith("s-1");
    expect(useAiStore.getState().sessions).toHaveLength(2);
  });

  it("归档与取消归档都按当前取反下发", () => {
    useAiStore.setState({ sessions: [sessionOf("s-1", "周报"), sessionOf("s-2", "旧闻", { archived: true })] });
    mount();
    fireEvent.click(screen.getByTitle("ai.archiveSession"));
    expect(ai.setSessionArchived).toHaveBeenCalledWith("s-1", true);
    // 取消归档那个按钮只在归档分区里渲染：先切页
    fireEvent.click(screen.getByText(/ai\.historyArchivedTab/));
    fireEvent.click(screen.getByTitle("ai.unarchiveSession"));
    expect(ai.setSessionArchived).toHaveBeenCalledWith("s-2", false);
  });

  it("超出显示窗口才给「加载更多」，且切到归档页就收掉", () => {
    useAiStore.setState({
      sessions: [sessionOf("s-1", "周报"), sessionOf("s-2", "月报"), sessionOf("s-3", "日报", { archived: true })],
      sessionsShown: 2,
    });
    mount();
    const more = screen.getByRole("button", { name: /ai\.loadMoreSessions/ });
    expect(more.textContent).toContain('ai.moreSessionCount:{"count":1}');
    fireEvent.click(more);
    expect(ai.loadMoreSessions).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText(/ai\.historyArchivedTab/));
    expect(screen.queryByRole("button", { name: /ai\.loadMoreSessions/ })).toBeNull();
  });
});
