import { beforeEach, describe, expect, it, vi } from "vitest";

const openMock = vi.hoisted(() => vi.fn());
const readDirMock = vi.hoisted(() => vi.fn());
const readTextFileMock = vi.hoisted(() => vi.fn());
const invokeMock = vi.hoisted(() => vi.fn());
const viewCreateMock = vi.hoisted(() => vi.fn());
const viewSetIconMock = vi.hoisted(() => vi.fn());
const viewSetTagsMock = vi.hoisted(() => vi.fn());
const viewSetFavoriteMock = vi.hoisted(() => vi.fn());
const docSaveMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openMock }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readDir: readDirMock, readTextFile: readTextFileMock }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock, convertFileSrc: (p: string) => p }));
vi.mock("./db", () => ({
  viewApi: {
    create: viewCreateMock,
    setIcon: viewSetIconMock,
    setTags: viewSetTagsMock,
    setFavorite: viewSetFavoriteMock,
  },
  newId: () => `id-${Math.random().toString(36).slice(2)}`,
}));
vi.mock("./documents", () => ({ documentApi: { save: docSaveMock } }));

import { importMarkdownFolder } from "./import-folder";

const ROOT = "D:/src";
const dir = (name: string) => ({ name, isDirectory: true, isFile: false });
const file = (name: string) => ({ name, isDirectory: false, isFile: true });

/** 源目录树：note/page.md（含 imgs/ 与 assets/ 子目录）+ 根级 readme.md */
const BASE_TREE: Record<string, { name: string; isDirectory: boolean; isFile: boolean }[]> = {
  [ROOT]: [dir("note"), file("readme.md")],
  [`${ROOT}/note`]: [dir("imgs"), dir("assets"), file("page.md")],
  [`${ROOT}/note/imgs`]: [file("a.png"), file("my photo.png")],
  [`${ROOT}/note/assets`]: [file("报告.pdf")],
};

/** 每个用例可在 beforeEach 后追加目录（用于「目录同名文件 = 该目录页正文」的场景） */
let TREE: Record<string, { name: string; isDirectory: boolean; isFile: boolean }[]> = {};

let TEXTS: Record<string, string> = {};

/** 第 n 个落库文档的 TipTap JSON 字符串（walkMd 先深后广：note/page.md 先于 readme.md） */
const saved = (index = 0): string => String(docSaveMock.mock.calls[index]?.[1] ?? "");

const copiedSources = (): string[] =>
  invokeMock.mock.calls
    .filter((c) => c[0] === "save_asset")
    .map((c) => String((c[1] as { sourcePath: string }).sourcePath));

describe("importMarkdownFolder（本地图片/附件收编）", () => {
  beforeEach(() => {
    openMock.mockReset();
    readDirMock.mockReset();
    readTextFileMock.mockReset();
    invokeMock.mockReset();
    viewCreateMock.mockReset();
    viewSetIconMock.mockReset();
    viewSetTagsMock.mockReset();
    viewSetFavoriteMock.mockReset();
    docSaveMock.mockReset();

    TREE = { ...BASE_TREE };
    openMock.mockResolvedValue(ROOT);
    readDirMock.mockImplementation((p: string) => Promise.resolve(TREE[p] ?? []));
    TEXTS = {};
    readTextFileMock.mockImplementation((p: string) => Promise.resolve(TEXTS[p] ?? ""));

    viewCreateMock.mockImplementation(() => Promise.resolve({ id: `v${viewCreateMock.mock.calls.length}` }));
    viewSetIconMock.mockResolvedValue(undefined);
    viewSetTagsMock.mockResolvedValue(undefined);
    viewSetFavoriteMock.mockResolvedValue(undefined);
    docSaveMock.mockResolvedValue(undefined);
  });

  /** save_asset 成功时返回 assets/<序号>.<原扩展名>；missing 里的源路径模拟磁盘上已不存在 */
  function mockSaveAsset(missing: string[] = []) {
    let n = 0;
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd !== "save_asset") return Promise.resolve(undefined);
      const sourcePath = String(args?.sourcePath);
      if (missing.includes(sourcePath)) return Promise.reject(new Error(`source file not found: ${sourcePath}`));
      return Promise.resolve(`assets/${++n}.${sourcePath.slice(sourcePath.lastIndexOf(".") + 1)}`);
    });
  }

  it("相对路径图片复制进本机 assets/ 并改写引用", async () => {
    mockSaveAsset();
    TEXTS[`${ROOT}/note/page.md`] = "# 标题页\n\n![图一](./imgs/a.png)\n";
    TEXTS[`${ROOT}/readme.md`] = "![同一张图](note/imgs/a.png)\n";

    const result = await importMarkdownFolder("ws-1");
    expect(result).toEqual({ total: 2, created: 2, failed: 0 });

    // 相对各自 md 所在目录解析，同一源文件跨文档也只复制一次
    expect(copiedSources()).toEqual([`${ROOT}/note/imgs/a.png`]);
    expect(saved(0)).toContain('"src":"assets/1.png"');
    expect(saved(0)).not.toContain("./imgs/a.png");
    expect(saved(1)).toContain('"src":"assets/1.png"');
  });

  it("URL 编码路径与空格文件名同样收编", async () => {
    mockSaveAsset();
    TEXTS[`${ROOT}/note/page.md`] = "![空格图](./imgs/my%20photo.png)\n";
    await importMarkdownFolder("ws-1");
    expect(copiedSources()).toEqual([`${ROOT}/note/imgs/my photo.png`]);
    expect(saved(0)).toContain('"src":"assets/1.png"');
  });

  it("远程 URL、data URI 与普通链接保持原样，不收编", async () => {
    mockSaveAsset();
    TEXTS[`${ROOT}/note/page.md`] =
      "![远程](https://cdn.example.com/x.png)\n![内联](data:image/png;base64,AAAA)\n[站点](https://example.com)\n";
    await importMarkdownFolder("ws-1");
    expect(copiedSources()).toEqual([]);
    const json = saved(0);
    expect(json).toContain("https://cdn.example.com/x.png");
    expect(json).toContain("data:image/png;base64,AAAA");
  });

  it("越出源目录的引用不收编（对话框未授权该路径）", async () => {
    mockSaveAsset();
    TEXTS[`${ROOT}/note/page.md`] = "![外部](../../Windows/notepad.exe)\n";
    await importMarkdownFolder("ws-1");
    expect(copiedSources()).toEqual([]);
    expect(saved(0)).toContain("../../Windows/notepad.exe");
  });

  it("附件引用 attach: 相对路径也收编，并保留 attach: 前缀", async () => {
    mockSaveAsset();
    TEXTS[`${ROOT}/note/page.md`] = "# 附件页\n\n[报告.pdf](attach:assets/报告.pdf)\n";
    await importMarkdownFolder("ws-1");
    expect(copiedSources()).toEqual([`${ROOT}/note/assets/报告.pdf`]);
    // 独占一段的 attach: 链接会被还原成附件节点，src 指向本机 assets/
    expect(saved(0)).toContain('{"type":"attachment","attrs":{"src":"assets/1.pdf","name":"报告.pdf"}}');
  });

  it("导出格式的图片宽度尾缀在改写后保留", async () => {
    mockSaveAsset();
    TEXTS[`${ROOT}/note/page.md`] = "![图](./imgs/a.png{width=60%})\n";
    await importMarkdownFolder("ws-1");
    expect(saved(0)).toContain('"width":60');
    expect(saved(0)).toContain('"src":"assets/1.png"');
  });

  it("本机文件缺失时保持原引用，文档照常导入", async () => {
    mockSaveAsset([`${ROOT}/note/imgs/a.png`]);
    TEXTS[`${ROOT}/note/page.md`] = "# 裂图页\n\n![图一](./imgs/a.png)\n";
    const result = await importMarkdownFolder("ws-1");
    expect(result.created).toBe(2);
    expect(result.failed).toBe(0);
    expect(saved(0)).toContain("./imgs/a.png");
  });

  it("同一张本地图片被多次引用时只复制一次", async () => {
    mockSaveAsset();
    TEXTS[`${ROOT}/note/page.md`] = "![一](./imgs/a.png)![二](imgs/a.png)\n";
    await importMarkdownFolder("ws-1");
    expect(copiedSources()).toEqual([`${ROOT}/note/imgs/a.png`]);
    expect(saved(0)).not.toContain("imgs/a.png");
  });

  it("frontmatter 的图标/标签/收藏回填到新建页面", async () => {
    mockSaveAsset();
    TEXTS[`${ROOT}/note/page.md`] = "---\ntitle: 带元信息\nicon: 📖\ntags: [工作, 重要]\nfavorite: true\n---\n正文\n";
    await importMarkdownFolder("ws-1");
    // 第 1 次 create 是父目录页（note），正文页本身是第 2 次 → id v2
    const pageIndex = viewCreateMock.mock.calls.findIndex((c) => (c[0] as { name: string }).name === "带元信息");
    expect(pageIndex).toBeGreaterThanOrEqual(0);
    expect(viewCreateMock.mock.calls[pageIndex]?.[0]).toMatchObject({ name: "带元信息", layout: "document" });
    const pageId = `v${pageIndex + 1}`;
    expect(viewSetIconMock).toHaveBeenCalledWith(pageId, "📖");
    expect(viewSetTagsMock).toHaveBeenCalledWith(pageId, ["工作", "重要"]);
    expect(viewSetFavoriteMock).toHaveBeenCalledWith(pageId, true);
  });

  it("layout: grid 的页面重建为数据库视图（表格灌进 csv_import，不退化成文档）", async () => {
    mockSaveAsset();
    TREE[`${ROOT}`] = [...TREE[`${ROOT}`], file("任务.md")];
    TEXTS[`${ROOT}/任务.md`] =
      "---\ntitle: 任务\nlayout: grid\n---\n# 任务\n\n| 标题 | 数量 | 状态 |\n| --- | --- | --- |\n| 写周报 | 3 | 进行中 |\n| 复盘 | 1 | 已完成 |\n";

    const result = await importMarkdownFolder("ws-1");
    expect(result).toEqual({ total: 3, created: 3, failed: 0 });

    const gridIndex = viewCreateMock.mock.calls.findIndex((c) => (c[0] as { layout: string }).layout === "grid");
    expect(gridIndex).toBeGreaterThanOrEqual(0);
    expect(viewCreateMock.mock.calls[gridIndex]?.[0]).toMatchObject({ name: "任务", layout: "grid" });
    // viewApi.create 的 mock 按调用序号发 id：第 i 次调用得到 v(i+1)
    const viewId = `v${gridIndex + 1}`;

    const payload = invokeMock.mock.calls.find((c) => c[0] === "csv_import")?.[1] as {
      viewId: string;
      fields: { name: string; field_type: string }[];
      rows: unknown[];
    };
    expect(payload.viewId).toBe(viewId);
    expect(payload.fields.map((f) => [f.name, f.field_type])).toEqual([
      ["标题", "text"],
      ["数量", "number"],
      ["状态", "text"],
    ]);
    expect(payload.rows).toHaveLength(2);
    expect(docSaveMock.mock.calls.some((c) => String(c[1]).includes("写周报"))).toBe(false);
  });

  it("目录同名文件就是该目录页的正文，不再另建一个重名子页", async () => {
    mockSaveAsset();
    TREE[`${ROOT}`] = [...TREE[`${ROOT}`], dir("项目")];
    TREE[`${ROOT}/项目`] = [file("项目.md"), file("子页.md")];
    TEXTS[`${ROOT}/项目/项目.md`] = "# 项目\n\n父页正文\n";
    TEXTS[`${ROOT}/项目/子页.md`] = "子页正文\n";

    const result = await importMarkdownFolder("ws-1");
    const names = viewCreateMock.mock.calls.map((c) => (c[0] as { name: string }).name);
    expect(names.filter((n) => n === "项目")).toHaveLength(1);
    expect(result).toEqual({ total: 4, created: 4, failed: 0 });
    // 父页正文落在目录页自己身上，而不是又一个同名子页
    const parentSave = docSaveMock.mock.calls.find((c) => String(c[1]).includes("父页正文"));
    expect(parentSave).toBeDefined();
  });
});
