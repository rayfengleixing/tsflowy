import { afterEach, describe, expect, it } from "vitest";
import type { ViewNode } from "@/types/models";
import { viewNode } from "@/test/view-node";

import { appLang, appTree, appWorkspaceId, bindAppReaders, resetAppReaders } from "./app-context";
import { LANGUAGES } from "./i18n/languages";

afterEach(() => resetAppReaders());

describe("app-context 读取单点", () => {
  it("语言未绑定时回落注册表首项，不在 t() 这类全仓消费点上抛", () => {
    expect(appLang()).toBe(LANGUAGES[0].code);
  });

  it("页面树与工作区未绑定时直接抛：把「没绑」当成「没有页面」会造出静默的假象", () => {
    expect(() => appTree()).toThrow(/app-context/);
    expect(() => appWorkspaceId()).toThrow(/app-context/);
    expect(() => appTree()).toThrow("getTree");
    expect(() => appWorkspaceId()).toThrow("getCurrentWorkspaceId");
  });

  it("分项绑定互不覆盖：settings 绑语言、workspace 绑树与工作区", () => {
    bindAppReaders({ getLang: () => "en-US" });
    bindAppReaders({ getTree: () => [viewNode("v1", "首页")], getCurrentWorkspaceId: () => "w-7" });
    expect(appLang()).toBe("en-US");
    expect(appTree().map((v) => v.name)).toEqual(["首页"]);
    expect(appWorkspaceId()).toBe("w-7");
  });

  it("绑的是取值函数而非快照：store 侧状态变了，lib 侧立刻读到新值", () => {
    let current: ViewNode[] = [viewNode("v1", "旧页")];
    bindAppReaders({ getTree: () => current });
    expect(appTree().map((v) => v.name)).toEqual(["旧页"]);
    current = [viewNode("v1", "新页")];
    expect(appTree().map((v) => v.name)).toEqual(["新页"]);
  });

  it("同名键后绑覆盖，注销函数回到它绑定前的那份 readers", () => {
    const undo = bindAppReaders({ getLang: () => "en-US" });
    bindAppReaders({ getLang: () => "zh-CN" });
    expect(appLang()).toBe("zh-CN");
    undo(); // 这里 prev 是首次绑定前的空 readers，等于把两次一起撤掉
    expect(appLang()).toBe(LANGUAGES[0].code);
  });

  it("工作区可以为 null（没选空间），null 不是「未绑定」", () => {
    bindAppReaders({ getCurrentWorkspaceId: () => null });
    expect(appWorkspaceId()).toBeNull();
  });
});
