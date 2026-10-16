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
