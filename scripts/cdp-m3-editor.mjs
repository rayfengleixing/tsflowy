// M3 编辑器+搜索验收冒烟：驱动 WebView2 CDP 完成 编辑/自动保存/重载持久化/slash/图片/搜索 验证。
// 用法: node scripts/cdp-m3-editor.mjs  （需先以 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 启动应用）
const BASE = "http://127.0.0.1:9222";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`${BASE}/json`)).json();
const page = list.find((p) => p.type === "page");
if (!page) throw new Error("NO_PAGE_FOUND: " + JSON.stringify(list));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws error")); });

let msgId = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const data = JSON.parse(e.data);
  if (data.id && pending.has(data.id)) {
    pending.get(data.id)(data);
    pending.delete(data.id);
  }
};
const cdp = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++msgId;
    pending.set(id, (data) => (data.error ? rej(new Error(method + ": " + JSON.stringify(data.error))) : res(data.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
const evalJs = async (expr) => {
  const res = await cdp("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (res.exceptionDetails) throw new Error("EVAL: " + JSON.stringify(res.exceptionDetails.exception?.description ?? res.exceptionDetails));
  return res.result?.value;
};
const key = (k, opts = {}) =>
  cdp("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: k,
    code: opts.code ?? k,
    windowsVirtualKeyCode: opts.vk ?? k.toUpperCase().charCodeAt(0),
    modifiers: opts.modifiers ?? 0,
  }).then(() =>
    cdp("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: k,
      code: opts.code ?? k,
      windowsVirtualKeyCode: opts.vk ?? k.toUpperCase().charCodeAt(0),
      modifiers: opts.modifiers ?? 0,
    }),
  );
const insertText = (text) => cdp("Input.insertText", { text });

const out = {};

// 注入页面辅助函数（失败重试；页面重载会清掉注入，重载后需再次调用）
const INJECT = `window.__h = {
  clickEl: (el) => {
    const o = { bubbles: true, cancelable: true, pointerType: "mouse", button: 0 };
    el.dispatchEvent(new PointerEvent("pointerdown", o));
    el.dispatchEvent(new PointerEvent("pointerup", o));
    el.click();
  },
  setInputValue: (input, value) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  },
};`;
const ensureHelpers = async () => {
  for (let i = 0; i < 5; i++) {
    await evalJs(INJECT);
    const ok = await evalJs("typeof window.__h");
    if (ok === "object") return;
    await sleep(300);
  }
};
await ensureHelpers();

const openFirstTreeDoc = async () => {
  await evalJs(`(() => {
    const items = [...document.querySelectorAll('[data-view-id]')];
    if (items.length) {
      const el = items[0];
      const o = { bubbles: true, cancelable: true, pointerType: "mouse", button: 0 };
      el.dispatchEvent(new PointerEvent("pointerdown", o));
      el.dispatchEvent(new PointerEvent("pointerup", o));
      el.click();
    }
    return items.length;
  })()`);
  await sleep(700);
};

// ---------- 0. 重载到干净状态，打开欢迎文档 ----------
await cdp("Page.reload");
await sleep(2500);
for (let i = 0; i < 60; i++) {
  const ready = await evalJs("!!document.querySelector('[data-view-id]')");
  if (ready) break;
  await sleep(500);
}
await ensureHelpers();
await openFirstTreeDoc();

// ---------- 1. 聚焦编辑器并输入中文/英文正文 ----------
const focused = await evalJs(`(() => {
  const el = document.querySelector('.tiptap');
  if (!el) return false;
  el.focus();
  return document.activeElement === el;
})()`);
out.editorFocused = focused;
await sleep(200);

// 清空现有内容（select all + backspace）
await key("a", { modifiers: 2 }); // Ctrl+A
await sleep(100);
await key("Backspace", { code: "Backspace", vk: 8 });
await sleep(300);

await insertText("这是一段中文正文，包含关键词：量子纠缠。");
await sleep(150);
await key("Enter", { code: "Enter", vk: 13 });
await sleep(100);
await insertText("English body text with keyword: tachyon speed.");
await sleep(1400); // 等自动保存 800ms 防抖完成

// ---------- 2. 验证自动保存：新建文档 → 切回（重新从 DB 加载） ----------
await evalJs(`(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('新建页面'));
  if (!btn) return false;
  window.__h.clickEl(btn);
  return true;
})()`);
await sleep(400);
const createdLayout = await evalJs(`(() => {
  const item = [...document.querySelectorAll('[role="menuitem"]')].find((m) => m.textContent.includes('文档'));
  if (!item) return 'NO_DOC_ITEM';
  window.__h.clickEl(item);
  return 'created';
})()`);
out.createdLayout = createdLayout;
await sleep(900); // 新文档打开（第二个标签）

const back = await evalJs(`(() => {
  const tabs = [...document.querySelectorAll('[data-tab-id]')];
  if (tabs.length < 2) return 'TABS:' + tabs.length;
  window.__h.clickEl(tabs[0]);
  return 'OK';
})()`);
out.switchBack = back;
await sleep(800);
const reloadedText = await evalJs("document.querySelector('.tiptap')?.innerText ?? ''");
out.persistedAfterTabSwitch = reloadedText.includes("量子纠缠") && reloadedText.includes("tachyon");

// ---------- 3. 页面重载（模拟重启）后内容仍在 ----------
await cdp("Page.reload");
await sleep(2500);
for (let i = 0; i < 30; i++) {
  const ok = await evalJs("!!document.querySelector('[data-view-id]')");
  if (ok) break;
  await sleep(500);
}
await openFirstTreeDoc();
const afterReload = await evalJs("document.querySelector('.tiptap')?.innerText ?? ''");
out.persistedAfterReload = afterReload.includes("量子纠缠") && afterReload.includes("tachyon");
out.reloadText = afterReload.slice(0, 120);

// ---------- 4. slash 菜单：清空后输入 "/" → 菜单出现；过滤"标题" → Enter 生成 H1 ----------
await evalJs("document.querySelector('.tiptap')?.focus()");
await sleep(300);
await key("a", { modifiers: 2 }); // Ctrl+A 清空，避免加载竞态影响光标位置
await sleep(150);
await key("Backspace", { code: "Backspace", vk: 8 });
await sleep(300);
await insertText("/");
await sleep(400);
out.slashMenuShown = await evalJs("document.body.innerText.includes('标题 1') && !!document.querySelector('.react-renderer')");
await insertText("标题");
await sleep(300);
await key("Enter", { code: "Enter", vk: 13 });
await sleep(500);
out.h1Created = await evalJs("!!document.querySelector('.tiptap h1')");
// 补一段含关键词的文本（清空步骤删掉了搜索词，这里重建以便后续搜索验证）
await key("Enter", { code: "Enter", vk: 13 });
await sleep(150);
await insertText("补充段落，关键词：量子纠缠 tachyon 依旧可搜。");
await sleep(1300); // 自动保存

// ---------- 5. 图片：贴 Markdown 图片语法 → image 节点 + asset 协议加载 ----------
await evalJs(`(() => {
  const dt = new DataTransfer();
  dt.setData('text/plain', '![测试图](assets/cdp-test.png)');
  const evt = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
  document.querySelector('.tiptap').dispatchEvent(evt);
  return true;
})()`);
await sleep(2200);
const imgInfo = await evalJs(`(() => {
  const img = document.querySelector('.tiptap img');
  if (!img) return null;
  return { src: img.getAttribute('src')?.slice(0, 90), loaded: img.complete && img.naturalWidth > 0 };
})()`);
out.image = imgInfo;

// ---------- 6. 搜索：Ctrl+K → 中文正文关键词 → 结果含命中摘要 → Enter 跳转 ----------
await evalJs("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))");
await sleep(400);
out.paletteOpened = await evalJs("!!document.querySelector('[role=\"dialog\"] input')");
await evalJs("document.querySelector('[role=\"dialog\"] input')?.focus()");
await insertText("量子纠缠");
await sleep(700);
out.chineseSearchHit = await evalJs("!!document.querySelector('[role=\"dialog\"] em')");
await key("Enter", { code: "Enter", vk: 13 });
await sleep(700);
out.paletteClosedAfterJump = await evalJs("!document.querySelector('[role=\"dialog\"]')");
out.editorOpenedAfterJump = await evalJs("!!document.querySelector('.tiptap')");

// ---------- 7. 英文搜索 ----------
await evalJs("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))");
await sleep(400);
await evalJs("document.querySelector('[role=\"dialog\"] input')?.focus()");
await insertText("tachyon");
await sleep(700);
out.englishSearchHit = await evalJs("!!document.querySelector('[role=\"dialog\"] em')");
await key("Escape", { code: "Escape", vk: 27 });
await sleep(300);

ws.close();
console.log(JSON.stringify(out, null, 2));
process.exit(0);