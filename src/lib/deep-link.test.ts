import { describe, expect, it } from "vitest";
import { parseDeepLinkViewId } from "./deep-link";

describe("parseDeepLinkViewId", () => {
  it("解析标准 page 深链", () => {
    expect(parseDeepLinkViewId("tsflowy://page/8f2f1a34-5678-4abc-9def-0123456789ab")).toBe(
      "8f2f1a34-5678-4abc-9def-0123456789ab",
    );
  });

  it("容忍 query 与 hash", () => {
    expect(parseDeepLinkViewId("tsflowy://page/abc?mode=edit#top")).toBe("abc");
    expect(parseDeepLinkViewId("tsflowy://page/abc#frag")).toBe("abc");
    expect(parseDeepLinkViewId("tsflowy://page/abc/?x=1")).toBe("abc");
  });

  it("容忍前后空白与大小写", () => {
    expect(parseDeepLinkViewId("  TsFlowy://Page/abc  ")).toBe("abc");
  });

  it("解码 percent-encoded 视图 id", () => {
    expect(parseDeepLinkViewId("tsflowy://page/a%20b")).toBe("a b");
  });

  it("非法输入返回 null", () => {
    expect(parseDeepLinkViewId("")).toBeNull();
    expect(parseDeepLinkViewId("https://page/abc")).toBeNull();
    expect(parseDeepLinkViewId("tsflowy://other/abc")).toBeNull();
    expect(parseDeepLinkViewId("tsflowy://page/")).toBeNull();
    expect(parseDeepLinkViewId("tsflowy://page")).toBeNull();
    expect(parseDeepLinkViewId("not a url")).toBeNull();
  });

  it("坏 percent 编码不抛异常，原样返回", () => {
    expect(parseDeepLinkViewId("tsflowy://page/100%")).toBe("100%");
  });
});
