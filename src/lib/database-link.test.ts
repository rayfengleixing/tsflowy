import { describe, expect, it } from "vitest";
import { cellLinkHref, isLinkFieldType } from "./database-link";

describe("cellLinkHref", () => {
  it("url 补全缺失的协议，只放行 http/https", () => {
    expect(cellLinkHref("url", "example.com")).toBe("https://example.com/");
    expect(cellLinkHref("url", "http://example.com/a")).toBe("http://example.com/a");
    expect(cellLinkHref("url", "  https://example.com  ")).toBe("https://example.com/");
    // 相对协议写法按 https 补
    expect(cellLinkHref("url", "//example.com")).toBe("https://example.com/");
  });

  it("非 http/https 的写法不给可点目标（交给纯文本）", () => {
    expect(cellLinkHref("url", "javascript:alert(1)")).toBeNull();
    expect(cellLinkHref("url", "file:///C:/Windows/system.ini")).toBeNull();
    expect(cellLinkHref("url", "data:text/html,hi")).toBeNull();
    expect(cellLinkHref("url", "mailto:a@b.com")).toBeNull();
    expect(cellLinkHref("url", "")).toBeNull();
    expect(cellLinkHref("url", "   ")).toBeNull();
  });

  it("email 一律走 mailto，已带前缀的不重复加", () => {
    expect(cellLinkHref("email", "a@b.com")).toBe("mailto:a@b.com");
    expect(cellLinkHref("email", "mailto:a@b.com")).toBe("mailto:a@b.com");
    expect(cellLinkHref("email", "MAILTO:a@b.com")).toBe("MAILTO:a@b.com");
    // 脏文本也只会变成收件人栏里的怪串，不会被当成脚本执行
    expect(cellLinkHref("email", "javascript:alert(1)")).toBe("mailto:javascript:alert(1)");
    expect(cellLinkHref("email", "  ")).toBeNull();
  });

  it("只有 url / email 两个类型参与链接展示", () => {
    expect(isLinkFieldType("url")).toBe(true);
    expect(isLinkFieldType("email")).toBe(true);
    // 电话在 Windows 上没有可靠的 tel: 处理程序，不做成可点
    expect(isLinkFieldType("phone")).toBe(false);
    expect(isLinkFieldType("text")).toBe(false);
  });
});
