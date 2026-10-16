import { describe, expect, it } from "vitest";
import { parseDeepLink, rowPermalink } from "./deep-link";

describe("parseDeepLink", () => {
  it("解析标准 page 深链，无行级目标", () => {
    expect(parseDeepLink("tsflowy://page/8f2f1a34-5678-4abc-9def-0123456789ab")).toEqual({
      viewId: "8f2f1a34-5678-4abc-9def-0123456789ab",
      rowId: null,
    });
  });

  it("容忍 query 与 hash", () => {
    expect(parseDeepLink("tsflowy://page/abc?mode=edit#top")).toEqual({ viewId: "abc", rowId: null });
    expect(parseDeepLink("tsflowy://page/abc#frag")).toEqual({ viewId: "abc", rowId: null });
    expect(parseDeepLink("tsflowy://page/abc/?x=1")).toEqual({ viewId: "abc", rowId: null });
  });

  it("取出 ?row= 行级目标（可在其它键之后、可被编码）", () => {
    expect(parseDeepLink("tsflowy://page/abc?row=r1")).toEqual({ viewId: "abc", rowId: "r1" });
    expect(parseDeepLink("tsflowy://page/abc?mode=edit&row=r1#top")).toEqual({ viewId: "abc", rowId: "r1" });
    expect(parseDeepLink("tsflowy://page/abc?row=r1&row=r2")).toEqual({ viewId: "abc", rowId: "r1" });
    expect(parseDeepLink("tsflowy://page/abc#row=r1")).toEqual({ viewId: "abc", rowId: null });
  });

  it("行 id 只认安全字符集：带引号/斜杠/超长的一律当没有行级目标", () => {
    // rowFocus 用 [data-row-id="…"] 选择器定位，脏值会让 querySelector 直接抛错
    expect(parseDeepLink('tsflowy://page/abc?row=r1"x')).toEqual({ viewId: "abc", rowId: null });
    expect(parseDeepLink("tsflowy://page/abc?row=a/b")).toEqual({ viewId: "abc", rowId: null });
    expect(parseDeepLink("tsflowy://page/abc?row=" + "x".repeat(65))).toEqual({ viewId: "abc", rowId: null });
    expect(parseDeepLink("tsflowy://page/abc?row=%20r1")).toEqual({ viewId: "abc", rowId: null });
  });

  it("容忍前后空白与大小写", () => {
    expect(parseDeepLink("  TsFlowy://Page/abc?row=r1  ")).toEqual({ viewId: "abc", rowId: "r1" });
  });

  it("解码 percent-encoded 视图 id", () => {
    expect(parseDeepLink("tsflowy://page/a%20b")).toEqual({ viewId: "a b", rowId: null });
  });

  it("非法输入返回 null", () => {
    expect(parseDeepLink("")).toBeNull();
    expect(parseDeepLink("https://page/abc")).toBeNull();
    expect(parseDeepLink("tsflowy://other/abc")).toBeNull();
    expect(parseDeepLink("tsflowy://page/")).toBeNull();
    expect(parseDeepLink("tsflowy://page")).toBeNull();
    expect(parseDeepLink("not a url")).toBeNull();
  });

  it("不吞掉编码错误的百分号序列", () => {
    expect(parseDeepLink("tsflowy://page/100%")).toEqual({ viewId: "100%", rowId: null });
  });
});

describe("rowPermalink", () => {
  it("产出的链接能被 parseDeepLink 原样读回", () => {
    const url = rowPermalink("8f2f1a34-5678-4abc-9def-0123456789ab", "r_1-2");
    expect(url).toBe("tsflowy://page/8f2f1a34-5678-4abc-9def-0123456789ab?row=r_1-2");
    expect(parseDeepLink(url)).toEqual({ viewId: "8f2f1a34-5678-4abc-9def-0123456789ab", rowId: "r_1-2" });
  });

  it("视图 id 里的保留字符转义后仍能还原", () => {
    expect(parseDeepLink(rowPermalink("a b/c", "r1"))).toEqual({ viewId: "a b/c", rowId: "r1" });
  });
});
