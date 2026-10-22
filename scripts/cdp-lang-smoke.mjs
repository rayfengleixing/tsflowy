// 语言切换真机冒烟：CDP 驱动原生窗口，在「设置 → 外观与语言」里把界面语言换掉，
// 断言整棵界面（侧栏齿轮按钮、设置页标题）跟着重渲染，再切回来确认应用还原。
// 这条验的正是 lib/app-context 收口后的运行时风险点：useLanguage() 不再直连 settings store，
// 订阅由 stores/settings.ts 交 subscribeLang、hook 在 app-context 里用 useSyncExternalStore 组。
// 单测与 jsdom 都能测这个形状，但「真窗口里切了语言界面到底刷不刷」只有这里能看到。
// 观测方式：全程收集 Runtime.exceptionThrown，任何断言失败即退出非 0。
// 前置: WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 npm run tauri dev
// 用法: node scripts/cdp-lang-smoke.mjs
const BASE = "http://127.0.0.1:9222";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`${BASE}/json`)).json();
const page = list.find((x) => x.type === "page");
if (!page) throw new Error("NO_PAGE");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let msgId = 0;
const pending = new Map();
const exceptions = [];
ws.onmessage = (e) => {
  const d = JSON.parse(e.data);
  if (d.id && pending.has(d.id)) {
    pending.get(d.id)(d);
    pending.delete(d.id);
    return;
  }
  if (d.method === "Runtime.exceptionThrown") {
    exceptions.push(d.params.exceptionDetails.exception?.description ?? JSON.stringify(d.params.exceptionDetails));
  }
};
const cdp = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++msgId;
    pending.set(id, (d) => (d.error ? rej(new Error(method + ": " + JSON.stringify(d.error))) : res(d.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
const evalJs = async (expr) => {
  const r = await cdp("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    throw new Error("EVAL: " + (r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails)));
  }
  return r.result?.value;
};
const assert = (cond, msg) => {
  if (!cond) throw new Error("ASSERT: " + msg);
  console.log("ok - " + msg);
};
const mouse = (type, x, y) =>
  cdp("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
const clickAt = async (x, y, after = 500) => {
  await mouse("mouseMoved", x, y);
  await wait(120);
  await mouse("mousePressed", x, y);
  await mouse("mouseReleased", x, y);
  await wait(after);
};
const clickByText = async (text) => {
  const pt = await evalJs(`(() => {
    const els = [...document.querySelectorAll('button')].filter(
      (x) => x.offsetParent !== null && x.textContent.trim() === ${JSON.stringify(text)}
    );
    if (!els.length) return null;
    const r = els[0].getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (!pt) throw new Error("NOT_CLICKABLE: " + text);
  await clickAt(pt.x, pt.y);
};
const waitFor = async (expr, desc, tries = 20, gap = 400) => {
  for (let i = 0; i < tries; i++) {
    if (await evalJs(expr)) return true;
    await wait(gap);
  }
  throw new Error("TIMEOUT: " + desc);
};
// 受控 <select>：改值要走原型 setter，再发原生 change，React 才认这次是用户改的
const pickLang = (code) =>
  evalJs(`(() => {
    const sel = [...document.querySelectorAll('select')].find(
      (s) => s.offsetParent !== null && [...s.options].some((o) => o.value === ${JSON.stringify(code)})
    );
    if (!sel) return "NO_SELECT";
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(sel, ${JSON.stringify(code)});
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return "OK";
  })()`);

await cdp("Runtime.enable");

// 等应用起来（原生窗口里有 IPC 桥、页面树渲染完成）
await waitFor(
  "!!window.__TAURI_INTERNALS__ && !!document.querySelector('[data-view-id], aside, nav')",
  "app not ready",
  60,
  500
);

const gearZh = await evalJs(
  `(() => {
  const b = [...document.querySelectorAll('button')].find((x) => x.title && /设置|Settings/.test(x.title));
  return b ? b.textContent.trim() : null;
})()`
);
assert(gearZh !== null, `侧栏齿轮按钮在页面上（当前文案「${gearZh}」）`);

await clickByText(gearZh);
await waitFor(
  `[...document.querySelectorAll('select')].some((s) => s.offsetParent !== null && [...s.options].some((o) => o.value === 'en-US'))`,
  "设置里的语言下拉没出现"
);
console.log("ok - 设置页已打开，语言下拉可见");

const zhGear = await evalJs(
  `[...document.querySelectorAll('button')].map((x) => x.textContent.trim()).filter((x) => x === '设置' || x === 'Settings').join(',')`
);
assert(zhGear === "设置", `切换前界面是中文（齿轮文案「${zhGear}」）`);

assert((await pickLang("en-US")) === "OK", "把语言选成 English");
await waitFor(
  `[...document.querySelectorAll('button')].some((x) => x.textContent.trim() === 'Settings')`,
  "切到英文后侧栏没重渲染"
);
const enProbe = await evalJs(`(() => ({
  htmlLang: document.documentElement.lang,
  gear: [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Settings')?.textContent.trim(),
  body: document.body.innerText.includes("Appearance") || document.body.innerText.includes("外观"),
}))()`);
assert(enProbe.gear === "Settings", "切英文：侧栏齿轮文案跟着变成 Settings（useLanguage 的订阅生效）");
assert(enProbe.htmlLang.startsWith("en"), `切英文：<html lang> 变成 ${enProbe.htmlLang}`);
console.log("ok - 切英文后设置页文案已重渲染");

assert((await pickLang("zh-CN")) === "OK", "把语言选回简体中文");
await waitFor(
  `[...document.querySelectorAll('button')].some((x) => x.textContent.trim() === '设置')`,
  "切回中文后侧栏没重渲染"
);
const zhProbe = await evalJs(`(() => ({
  htmlLang: document.documentElement.lang,
  gear: [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '设置')?.textContent.trim(),
}))()`);
assert(zhProbe.gear === "设置", "切回中文：侧栏文案还原");
assert(zhProbe.htmlLang.startsWith("zh"), `切回中文：<html lang> 变成 ${zhProbe.htmlLang}`);

// 离开设置页，别把应用停在设置界面
await clickByText("设置");

assert(exceptions.length === 0, "全程没有未捕获异常");
if (exceptions.length) console.log("exceptions:\n" + exceptions.join("\n---\n"));
console.log("PASS: 语言切换在真窗口里整棵界面重渲染");
process.exit(0);
