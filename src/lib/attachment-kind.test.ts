import { describe, expect, it } from "vitest";
import { attachmentKindOf, extOfName, IMAGE_EXTS } from "./attachment-kind";

describe("extOfName", () => {
  it("取最后一个点之后的小写扩展名", () => {
    expect(extOfName("报告.PDF")).toBe("pdf");
    expect(extOfName("assets/1712.mp4")).toBe("mp4");
    expect(extOfName("archive.tar.gz")).toBe("gz");
  });

  it("没有点、点在最前、扩展名超长或含非法字符都算取不到", () => {
    expect(extOfName("README")).toBeNull();
    expect(extOfName(".gitignore")).toBeNull();
    expect(extOfName("x.abcdefgh")).toBeNull();
    expect(extOfName("x.mp3 ")).toBeNull();
    expect(extOfName("")).toBeNull();
  });
});

describe("attachmentKindOf", () => {
  it("按扩展名分四类可预览类型", () => {
    expect(attachmentKindOf("周报.pdf")).toBe("pdf");
    expect(attachmentKindOf("会议.MP3")).toBe("audio");
    expect(attachmentKindOf("讲解.flac")).toBe("audio");
    expect(attachmentKindOf("片段.mp4")).toBe("video");
    expect(attachmentKindOf("录屏.webm")).toBe("video");
    expect(attachmentKindOf("配图.svg")).toBe("image");
    expect(IMAGE_EXTS.has("avif")).toBe(true);
  });

  it("认不出的类型走 other：Chromium 播不了的容器宁可给下载链接", () => {
    expect(attachmentKindOf("工具.zip")).toBe("other");
    expect(attachmentKindOf("现场.avi")).toBe("other");
    expect(attachmentKindOf("录像.mkv")).toBe("other");
    expect(attachmentKindOf("笔记.md")).toBe("other");
    expect(attachmentKindOf("README")).toBe("other");
  });

  it("文件名拿不准时再看相对路径（附件存的是 assets/<nanos>.<ext>）", () => {
    expect(attachmentKindOf("截图.PNG", "assets/1712")).toBe("image");
    expect(attachmentKindOf("会议录音", "assets/1712.m4a")).toBe("audio");
    expect(attachmentKindOf("", "assets/1712.pdf")).toBe("pdf");
    expect(attachmentKindOf(undefined, null, "assets/1712.mp4")).toBe("video");
  });

  it("两个候选都读不出扩展名时才是 other", () => {
    expect(attachmentKindOf("附件", "assets/1712")).toBe("other");
    expect(attachmentKindOf()).toBe("other");
  });

  it("第一个候选带合法但陌生的扩展名就定案，不再拿路径去猜（名字才是用户看到的）", () => {
    expect(attachmentKindOf("伪装.pdf.exe", "assets/1712.pdf")).toBe("other");
  });
});
