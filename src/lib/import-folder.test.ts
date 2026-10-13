import { beforeEach, describe, expect, it, vi } from "vitest";

const openMock = vi.hoisted(() => vi.fn());
const readDirMock = vi.hoisted(() => vi.fn());
const readTextFileMock = vi.hoisted(() => vi.fn());
const invokeMock = vi.hoisted(() => vi.fn());
const viewCreateMock = vi.hoisted(() => vi.fn());
const docSaveMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openMock }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readDir: readDirMock, readTextFile: readTextFileMock }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock, convertFileSrc: (p: string) => p }));
vi.mock("./db", () => ({ viewApi: { create: viewCreateMock } }));
vi.mock("./documents", () => ({ documentApi: { save: docSaveMock } }));

import { importMarkdownFolder } from "./import-folder";

const ROOT = "D:/src";
const dir = (name: string) => ({ name, isDirectory: true, isFile: false });
const file = (name: string) => ({ name, isDirectory: false, isFile: true });

/** 源目录树：note/page.md（含 imgs/ 与 assets/ 子目录）+ 根级 readme.md */
const TREE: Record<string, { name: string; isDirectory: boolean; isFile: boolean }[]> = {
  [ROOT]: [dir("note"), file("readme.md")],
  [`${ROOT}/note`]: [dir("imgs"), dir("assets"), file("page.md")],
  [`${ROOT}/note/imgs`]: [file("a.png"), file("my photo.png")],
  [`${ROOT}/note/assets`]: [file("报告.pdf")],
};

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
    docSaveMock.mockReset();

    openMock.mockResolvedValue(ROOT);
    readDirMock.mockImplementation((p: string) => Promise.resolve(TREE[p] ?? []));
    TEXTS = {};
    readTextFileMock.mockImplementation((p: string) => Promise.resolve(TEXTS[p] ?? ""));

    viewCreateMock.mockImplementation(() => Promise.resolve({ id: `v${viewCreateMock.mock.calls.length}` }));
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
});
