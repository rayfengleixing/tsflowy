import { describe, expect, it } from "vitest";
import { buildFrontmatter, splitFrontmatter } from "./frontmatter";
import { DB_LAYOUTS } from "@/types/models";

describe("frontmatter 往返", () => {
  it("写出并按原样读回标题/图标/标签/收藏/布局", () => {
    const fm = buildFrontmatter({
      title: "项目 周报",
      icon: "📖",
      layout: "grid",
      tags: ["工作", '带"引号', "含, 逗号"],
      favorite: true,
      updatedAtMs: Date.parse("2026-10-15T08:00:00.000Z"),
    });
    expect(fm.startsWith("---\n")).toBe(true);
    const { meta, body } = splitFrontmatter(fm + "正文\n");
    expect(body).toBe("正文\n");
    expect(meta).toEqual({
      title: "项目 周报",
      icon: "📖",
      layout: "grid",
      tags: ["工作", '带"引号', "含, 逗号"],
      favorite: true,
      updatedAtMs: Date.parse("2026-10-15T08:00:00.000Z"),
    });
  });

  it("默认项（文档布局、未收藏、空标签）不写进文件", () => {
    const fm = buildFrontmatter({ title: "x", layout: "document", favorite: false, tags: [] });
    expect(fm).toBe("---\ntitle: x\n---\n");
    expect(buildFrontmatter({})).toBe("");
  });

  it("无 frontmatter 块的正文原样返回", () => {
    const md = "---\n段落一\n";
    expect(splitFrontmatter(md)).toEqual({ meta: {}, body: md });
    // 非法 layout 值被忽略，其余字段仍读出来
    const { meta } = splitFrontmatter('---\ntitle: T\nlayout: kanban2\nicon: "🧪"\n---\n正文');
    expect(meta.layout).toBeUndefined();
    expect(meta.icon).toBe("🧪");
  });

  it("每种数据库布局（含 list / gallery）都能往返", () => {
    // document 是默认值，buildFrontmatter 刻意不写它
    for (const layout of DB_LAYOUTS) {
      expect(splitFrontmatter(buildFrontmatter({ layout })).meta.layout).toBe(layout);
    }
  });
});

describe("frontmatter 别名（aliases）", () => {
  it("与标签一起写出并读回", () => {
    const fm = buildFrontmatter({ title: "T", tags: ["工作"], aliases: ["旧名", "含, 逗号", '带"引号'] });
    expect(fm).toContain('aliases: [旧名, "含, 逗号", "带\\"引号"]');
    expect(splitFrontmatter(fm).meta).toEqual({ title: "T", tags: ["工作"], aliases: ["旧名", "含, 逗号", '带"引号'] });
  });

  it("识别 Obsidian 的缩进列表写法", () => {
    const { meta } = splitFrontmatter('---\ntitle: T\naliases:\n  - 旧名\n  - "带, 逗号"\ntags:\n  - 工作\n---\n正文');
    expect(meta.aliases).toEqual(["旧名", "带, 逗号"]);
    expect(meta.tags).toEqual(["工作"]);
  });

  it("识别裸逗号写法，空列表读回为缺省", () => {
    expect(splitFrontmatter("---\naliases: 旧名, 缩写\n---\n").meta.aliases).toEqual(["旧名", "缩写"]);
    expect(splitFrontmatter("---\naliases: []\n---\n").meta.aliases).toBeUndefined();
    expect(splitFrontmatter("---\naliases:\n---\n").meta.aliases).toBeUndefined();
  });

  it("空别名不写进文件；缩进项只归属于紧邻的列表键", () => {
    expect(buildFrontmatter({ title: "x", aliases: [] })).toBe("---\ntitle: x\n---\n");
    const { meta } = splitFrontmatter("---\ntitle: T\nfavorite: true\n  - 不是成员\n---\n");
    expect(meta.favorite).toBe(true);
    expect(meta.title).toBe("T");
  });
});
