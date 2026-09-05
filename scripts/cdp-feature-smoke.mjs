// 功能冒烟：①行详情直接建文本字段+点图标改类型 ②页面属性直接建文本属性+点图标改类型 ③trigram 短词正文搜索。
// 观测方式：CDP 驱动真实 WebView，全程收集 Runtime.exceptionThrown，任何断言失败即退出非 0。
// radix 触发器吃 pointerdown，必须走真实鼠标事件；纯 onClick 元素可用 el.click()。
// 幂等：新增字段/属性走 invoke 原样清理（field_delete / pp_remove），搜索只读，可反复运行。
// 前置: WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 npm run tauri dev
// 用法: node scripts/cdp-feature-smoke.mjs
const BASE = "http://127.0.0.1:9222";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); return; }
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
  if (r.exceptionDetails) throw new Error("EVAL: " + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails));
  return r.result?.value;
};
const assert = (cond, msg) => {
  if (!cond) throw new Error("ASSERT: " + msg);
  console.log("ok - " + msg);
};
const mouse = (type, x, y, extra = {}) => cdp("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, ...extra });
const clickAt = async (x, y, wait = 400) => {
  await mouse("mouseMoved", x, y);
  await sleep(120);
  await mouse("mousePressed", x, y);
  await mouse("mouseReleased", x, y);
  await sleep(wait);
};
// 滚动到可见再取中心（行详情/属性行可能被容器裁剪）
const rectCenterScrolled = (findExpr) => evalJs(`(() => {
  const el = (${findExpr});
  if (!el || el.offsetParent === null) return null;
  el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
})()`);
const clickVisibleText = async (text, wait = 500) => {
  const pt = await evalJs(`(() => {
    const all = [...document.querySelectorAll('button,[role=menuitem]')].filter(x => x.offsetParent !== null && x.textContent.trim().includes(${JSON.stringify(text)}));
    const el = all.find(x => x.getAttribute('role') === 'menuitem') ?? all[0];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (!pt) return false;
  await clickAt(pt.x, pt.y, wait);
  return true;
};
const waitFor = async (fn, desc, tries = 12, gap = 400) => {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await sleep(gap);
  }
  throw new Error("TIMEOUT: " + desc);
};

await cdp("Runtime.enable");
const out = {};

// 等应用就绪（树渲染出来）
const waitReady = async () => {
  for (let i = 0; i < 60; i++) {
    if (await evalJs("!!window.__TAURI_INTERNALS__ && !!document.querySelector('[data-view-id]')")) return true;
    await sleep(500);
  }
  return false;
};
const inv = (cmd, args) => evalJs(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? {})})`);
// location.reload() 会先销毁执行上下文再回包，await 会永远挂起 → 只发不等
const reloadPage = () => ws.send(JSON.stringify({ id: ++msgId, method: "Runtime.evaluate", params: { expression: "location.reload()" } }));

// 1. 第一轮就绪 → 关标签 → 清理 DB 遗留 → 整页刷新重建 store。
//    顺序很关键：应用启动会恢复标签并预载数据，若先清 DB 后加载，out-of-band 删除会在
//    store 里留下幻影字段；因此清理后必须 reload，让 store 从干净 DB 重建。
assert(await waitReady(), "app ready (round 1)");

let guard = 0;
while ((await evalJs("document.querySelectorAll('[data-tab-id]').length")) > 0 && guard++ < 30) {
  await evalJs(`document.querySelectorAll('[data-tab-id]')[0].querySelector('[data-testid="tab-close"]').click()`);
  await sleep(250);
}
const preCleaned = await evalJs(`(async () => {
  const inv = window.__TAURI_INTERNALS__.invoke;
  const removed = [];
  const wss = await inv('workspace_list', {});
  for (const w of wss) {
    const views = await inv('view_list_by_workspace', { workspaceId: w.id });
    for (const v of views) {
      if (v.is_trash) continue;
      if (v.layout === 'document' && !(v.extra || '').includes('row_detail')) {
        const props = await inv('pp_list', { viewId: v.id });
        for (const p of props) {
          if (p.key === '属性' || /^属性 \\d+$/.test(p.key)) { await inv('pp_remove', { viewId: v.id, key: p.key }); removed.push('pp:' + v.name); }
        }
      }
      if (v.layout === 'grid') {
        const fields = await inv('field_list', { viewId: v.id });
        for (const f of fields) {
          if (f.name === '字段' || /^字段 \\d+$/.test(f.name) || f.name === '字段r') { await inv('field_delete', { fieldId: f.id }); removed.push('field:' + v.name); }
        }
      }
    }
  }
  return removed.length;
})()`);
console.log("ok - tabs closed, pre-cleaned leftovers: " + preCleaned);

reloadPage();
await sleep(1500);
assert(await waitReady(), "app ready (round 2, store rebuilt)");

// ---------- 1. 行详情：直接建文本字段 + 点图标改类型 ----------
const grid = await inv("workspace_list").then(async (wss) => {
  for (const w of wss) {
    const views = await inv("view_list_by_workspace", { workspaceId: w.id });
    const g = views.find((v) => v.layout === "grid" && !v.is_trash && !(v.extra || "").includes("row_detail"));
    if (g) return g;
  }
  return null;
});
assert(!!grid, "grid view exists (" + (grid?.name ?? "none") + ")");

const opened = await evalJs(`(() => {
  const el = [...document.querySelectorAll('[data-view-id]')].find(e => e.textContent.includes(${JSON.stringify(grid.name)}));
  if (!el) return false;
  el.click();
  return true;
})()`);
await sleep(800);
assert(opened, "grid view opened by tree click");
await evalJs(`document.querySelector('table .lucide-external-link')?.closest('button')?.click()`);
await sleep(600);
assert(await evalJs(`!!document.querySelector('[data-testid="close-row-detail"]')`), "row detail panel opens");

const fieldsBefore = await inv("field_list", { viewId: grid.id });
const beforeIds = new Set(fieldsBefore.map((f) => f.id));

await evalJs(`document.querySelector('[data-testid="add-row-field"]')?.click()`);
const newField = await waitFor(async () => {
  const fields = await inv("field_list", { viewId: grid.id });
  return fields.length === fieldsBefore.length + 1 ? fields.find((f) => !beforeIds.has(f.id)) : null;
}, "field created in db");
assert(newField.name === "字段" || /^字段 \d+$/.test(newField.name), "new field default-named 字段, got " + JSON.stringify(newField.name));
assert(newField.field_type === "text", "new field type is text");

// 非主字段才有可点图标：图标数 = 字段数 - 1（新增后）
const iconCount = await evalJs(`document.querySelectorAll('[data-testid="row-field-icon"]').length`);
assert(iconCount === fieldsBefore.length, "row-field-icon count = fields-1 (primary has no menu), got " + iconCount + " vs " + fieldsBefore.length);

// 点新字段的图标（真实鼠标）→ 菜单 → 选「数字」
const iconPt = await waitFor(() => rectCenterScrolled(`[...document.querySelectorAll('[data-testid="row-field-icon"]')].pop()`), "new field icon visible");
await clickAt(iconPt.x, iconPt.y);
assert(await evalJs(`!!document.querySelector('[role="menu"]')`), "field type menu opens from icon");
const picked = await clickVisibleText("数字");
assert(picked, "menuitem 数字 clicked");
await waitFor(async () => (await inv("field_list", { viewId: grid.id })).find((f) => f.id === newField.id)?.field_type === "number", "field type changed to number");
console.log("ok - field type changed to number (db verified)");

// 点新字段名称 → 行内输入 → blur 落库（React 受控输入用 native setter 触发）
const namePt = await waitFor(() => rectCenterScrolled(`(() => {
  const icons = [...document.querySelectorAll('[data-testid="row-field-icon"]')];
  return icons[icons.length - 1]?.closest('div')?.querySelector('[data-testid="row-field-name"]');
})()`), "new field name visible");
await clickAt(namePt.x, namePt.y);
const nameSet = await evalJs(`(() => {
  const input = document.querySelector('[data-testid="row-field-name-input"]');
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, '字段r');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.blur();
  return true;
})()`);
assert(nameSet, "rename input appeared and value set");
await waitFor(async () => (await inv("field_list", { viewId: grid.id })).find((f) => f.id === newField.id)?.name === "字段r", "field renamed in db");
console.log("ok - field renamed via name click (db verified)");

// 清理：删掉临时字段
await inv("field_delete", { fieldId: newField.id });
await waitFor(async () => (await inv("field_list", { viewId: grid.id })).length === fieldsBefore.length, "field deleted");
await evalJs(`document.querySelector('[data-testid="close-row-detail"]')?.click()`);
await sleep(400);
console.log("ok - temp field cleaned up");

// ---------- 2. 页面属性：直接建文本属性 + 点图标改类型 ----------
const docView = await inv("workspace_list").then(async (wss) => {
  for (const w of wss) {
    const views = await inv("view_list_by_workspace", { workspaceId: w.id });
    const d = views.find((v) => v.layout === "document" && !v.is_trash && !(v.extra || "").includes("row_detail"));
    if (d) return d;
  }
  return null;
});
assert(!!docView, "document view exists (" + (docView?.name ?? "none") + ")");
const docOpened = await evalJs(`(() => {
  const el = [...document.querySelectorAll('[data-view-id]')].find(e => e.textContent.includes(${JSON.stringify(docView.name)}));
  if (!el) return false;
  el.click();
  return true;
})()`);
await sleep(800);
assert(docOpened, "document view opened");

const propsBefore = await inv("pp_list", { viewId: docView.id });
const keysBefore = new Set(propsBefore.map((p) => p.key));

await evalJs(`document.querySelector('[data-testid="add-prop"]')?.click()`);
const newProp = await waitFor(async () => {
  const props = await inv("pp_list", { viewId: docView.id });
  return props.length === propsBefore.length + 1 ? props.find((p) => !keysBefore.has(p.key)) : null;
}, "property created in db");
assert(newProp.key === "属性" || /^属性 \d+$/.test(newProp.key), "new property default-named 属性, got " + JSON.stringify(newProp.key));
assert(newProp.field_type === "text", "new property type is text");
assert(newProp.value === "", "new property value is empty");

// 点新属性的图标（真实鼠标）→ 菜单 → 选「日期」
const propIconPt = await waitFor(() => rectCenterScrolled(`(() => {
  const icons = [...document.querySelectorAll('[data-testid="prop-icon"]')];
  return icons[icons.length - 1];
})()`), "new property icon visible");
await clickAt(propIconPt.x, propIconPt.y);
assert(await evalJs(`!!document.querySelector('[role="menu"]')`), "property type menu opens from icon");
const pickedDate = await clickVisibleText("日期");
assert(pickedDate, "menuitem 日期 clicked");
await waitFor(async () => (await inv("pp_list", { viewId: docView.id })).find((p) => p.key === newProp.key)?.field_type === "date", "property type changed to date");
console.log("ok - property type changed to date (db verified)");

// 清理：删掉临时属性
await inv("pp_remove", { viewId: docView.id, key: newProp.key });
await waitFor(async () => (await inv("pp_list", { viewId: docView.id })).length === propsBefore.length, "property deleted");
console.log("ok - temp property cleaned up");

// ---------- 3. trigram 短词正文搜索 ----------
const ws0 = (await inv("workspace_list"))[0];
const docViews = (await inv("view_list_by_workspace", { workspaceId: ws0.id }))
  .filter((v) => v.layout === "document" && !v.is_trash && !(v.extra || "").includes("row_detail"));

// 从现有文档正文里挑一个汉字作为 1 字查询；没有则临时种一个文档
let probe = null;
for (const v of docViews) {
  const content = await inv("doc_get", { viewId: v.id });
  const ch = (content ?? "").match(/[\u4e00-\u9fff]/)?.[0];
  if (ch) { probe = { viewId: v.id, ch, seeded: false }; break; }
}
if (!probe) {
  const id = "tmp-search-" + Date.now();
  await inv("view_create", { id, workspaceId: ws0.id, parentId: null, name: "临时搜索页", layout: "document", extra: "{}" });
  await inv("doc_save", { viewId: id, content: JSON.stringify({ text: "短词搜索验证页" }) });
  probe = { viewId: id, ch: "短", seeded: true };
  console.log("ok - seeded temp doc for search probe");
}
const hits = await inv("search", { workspaceId: ws0.id, query: probe.ch });
assert(hits.length >= 1, "1-char query returns hits, got " + hits.length);
assert(hits.some((h) => h.view_id === probe.viewId), "content LIKE fallback finds the doc view containing the char");
assert(hits.every((h) => h.rank === 1e9), "short-query hits all come from LIKE fallback (rank 1e9)");
if (probe.seeded) {
  await inv("view_purge", { id: probe.viewId });
  console.log("ok - temp doc purged");
}
console.log("ok - short query \"" + probe.ch + "\" hits content via fallback");

assert(exceptions.length === 0, "no runtime exceptions during smoke" + (exceptions.length ? ": " + exceptions.join(" | ") : ""));
console.log("SMOKE PASS " + JSON.stringify(out));
