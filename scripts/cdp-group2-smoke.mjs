// group 2 selector 拆分冒烟：建子页面→展开折叠 / 打开视图+标签 / 空间下拉 / 回收站路由 / 行详情面板 / 清理。
// 观测方式：CDP 驱动真实 WebView，全程收集 Runtime.exceptionThrown，任何一步断言失败即退出非 0。
// radix 触发器吃 pointerdown，必须走真实鼠标事件；纯 onClick 元素可用 el.click()。
// 幂等：临时子页统一叫「无标题页面」，开头/结尾都清理，可反复运行。
// 前置: WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 npm run tauri dev
// 用法: node scripts/cdp-group2-smoke.mjs
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
const rectCenter = (sel) => evalJs(`(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el || el.offsetParent === null) return null;
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
const rowCount = () => evalJs("document.querySelectorAll('[data-view-id]').length");
const childCountOf = (id) => evalJs(`(() => {
  const row = document.querySelector('[data-view-id="${id}"]');
  if (!row) return -1;
  let n = 0, s = row.nextElementSibling;
  while (s && s.matches('[data-view-id]') && getComputedStyle(s).paddingLeft !== '16px') { n++; s = s.nextElementSibling; }
  return n;
})()`);
const tempChildIds = () => evalJs(`[...document.querySelectorAll('[data-view-id]')]
  .filter(e => e.textContent.includes('无标题页面'))
  .map(e => e.getAttribute('data-view-id'))`);
// 删除一个树行（悬停 → 行菜单 → 删除 → 确认框非取消按钮）
const deleteRowById = async (id) => {
  const pt = await rectCenter(`[data-view-id="${id}"]`);
  if (!pt) return false;
  await mouse("mouseMoved", pt.x, pt.y);
  await sleep(200);
  const menuPt = await rectCenter(`[data-view-id="${id}"] [data-testid="row-menu"]`);
  if (!menuPt) return false;
  await clickAt(menuPt.x, menuPt.y);
  if (!(await clickVisibleText("删除", 400))) return false;
  await evalJs(`(() => {
    const btns = [...document.querySelectorAll('[role="dialog"] button')];
    const confirm = btns.find(b => b.textContent.trim() !== "取消");
    confirm?.click();
    return !!confirm;
  })()`);
  await sleep(600);
  return !(await evalJs(`!!document.querySelector('[data-view-id="${id}"]')`));
};
const cleanupTemp = async (tag) => {
  const ids = (await tempChildIds()) ?? [];
  for (const id of ids) {
    const ok = await deleteRowById(id);
    console.log((ok ? "ok - " : "warn - ") + tag + " cleanup delete " + id + (ok ? "" : " FAILED"));
  }
  if (ids.length) await sleep(300);
  return ids.length;
};

await cdp("Runtime.enable");
const out = {};

// 0. 等应用就绪
let ready = false;
for (let i = 0; i < 60; i++) {
  if (await evalJs("!!window.__TAURI_INTERNALS__ && !!document.querySelector('[data-view-id]')")) { ready = true; break; }
  await sleep(500);
}
assert(ready, "app ready + tree rendered");

// 0.5 幂等清理：前次运行遗留的临时页（若展开可见）
out.preCleaned = await cleanupTemp("pre");

// 1. 给第一个根行建一个子页面（文档）：悬停行 → 点行尾 + → 菜单点「文档」
const root0 = await evalJs(`(() => {
  const row = [...document.querySelectorAll('[data-view-id]')].find(e => getComputedStyle(e).paddingLeft === '16px');
  return row.getAttribute('data-view-id');
})()`);
out.childrenBefore = await childCountOf(root0);
const rowPt = await rectCenter(`[data-view-id="${root0}"]`);
await mouse("mouseMoved", rowPt.x, rowPt.y);
await sleep(200);
const addPt = await rectCenter(`[data-view-id="${root0}"] [data-testid="row-add"]`);
assert(!!addPt, "row-add button visible after hover");
await clickAt(addPt.x, addPt.y);
const created = await clickVisibleText("文档");
assert(created, "subpage menu item clicked");
let childrenAfterCreate = out.childrenBefore;
for (let i = 0; i < 6; i++) {
  await sleep(500);
  childrenAfterCreate = await childCountOf(root0);
  if (childrenAfterCreate === out.childrenBefore + 1) break;
}
assert(childrenAfterCreate === out.childrenBefore + 1, "subpage created under root row");
out.childId = await evalJs(`(() => {
  const row = document.querySelector('[data-view-id="${root0}"]');
  let s = row.nextElementSibling;
  while (s && s.matches('[data-view-id]') && getComputedStyle(s).paddingLeft !== '16px') {
    if (!s.nextElementSibling || !s.nextElementSibling.matches('[data-view-id]') || getComputedStyle(s.nextElementSibling).paddingLeft === '16px') return s.getAttribute('data-view-id');
    s = s.nextElementSibling;
  }
  return null;
})()`);
assert(!!out.childId, "parent has visible children");

// 2. 展开/折叠：切 chevron，root0 子行数随 expanded.has 派生 selector 变化（chevron 是纯 onClick，可 el.click）
const chevClick = `document.querySelector('[data-view-id="${root0}"] button svg.lucide-chevron-right').closest('button').click()`;
await evalJs(chevClick);
await sleep(400);
out.childrenCollapsed = await childCountOf(root0);
assert(out.childrenCollapsed === 0, "collapse hides children (expanded.has=false, no re-render crash)");
await evalJs(chevClick);
await sleep(400);
out.childrenExpandedAgain = await childCountOf(root0);
assert(out.childrenExpandedAgain === childrenAfterCreate, "expand shows children again");

// 3. 关掉全部标签 → 打开两个视图 → 标签数 2；关一个 → 1；激活行高亮正确
let guard = 0;
while ((await evalJs("document.querySelectorAll('[data-tab-id]').length")) > 0 && guard++ < 30) {
  await evalJs(`document.querySelectorAll('[data-tab-id]')[0].querySelector('[data-testid="tab-close"]').click()`);
  await sleep(250);
}
const rootIds = await evalJs("[...document.querySelectorAll('[data-view-id]')].filter(e => getComputedStyle(e).paddingLeft === '16px').map(e => e.getAttribute('data-view-id'))");
assert(rootIds.length >= 2, "at least 2 root rows, got " + rootIds.length);
await evalJs(`document.querySelector('[data-view-id="${rootIds[0]}"]').click()`);
await sleep(500);
await evalJs(`document.querySelector('[data-view-id="${rootIds[1]}"]').click()`);
await sleep(500);
out.tabs = await evalJs("document.querySelectorAll('[data-tab-id]').length");
assert(out.tabs === 2, "two tabs open after close-all, got " + out.tabs);
out.activeOk = await evalJs(`!!document.querySelector('[data-view-id="${rootIds[1]}"].bg-brand-100')`);
assert(out.activeOk, "second view row shows active highlight");
await evalJs(`document.querySelectorAll('[data-tab-id]')[0].querySelector('[data-testid="tab-close"]').click()`);
await sleep(400);
out.tabsAfterClose = await evalJs("document.querySelectorAll('[data-tab-id]').length");
assert(out.tabsAfterClose === 1, "tab close works, got " + out.tabsAfterClose);

// 4. 空间下拉：真实鼠标打开 → 菜单出现 → 点空白处关闭
const swPt = await evalJs(`(() => {
  const b = document.querySelector('svg.lucide-chevrons-up-down')?.closest('button');
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
})()`);
assert(!!swPt, "space switcher button found");
await clickAt(swPt.x, swPt.y);
out.menuOpen = await evalJs(`!!document.querySelector('[role="menu"]')`);
assert(out.menuOpen, "space dropdown menu opens");
await clickAt(Math.round((await evalJs("window.innerWidth")) / 2), 4, 400);
out.menuClosed = await evalJs(`!document.querySelector('[role="menu"]')`);
assert(out.menuClosed, "space dropdown closes on outside click");

// 5. 回收站路由：主区出现回收站标题（与按钮标签同文本，语言无关），返回后主区恢复编辑器
out.trashLabel = await evalJs(`document.querySelector('[data-testid="trash-button"]').textContent.trim()`);
await evalJs(`document.querySelector('[data-testid="trash-button"]').click()`);
await sleep(500);
out.trashShown = await evalJs(`[...document.querySelectorAll('h1')].map(h => h.textContent.trim()).includes(${JSON.stringify(out.trashLabel)})`);
assert(out.trashShown, "trash page title renders in main area (label: " + out.trashLabel + ")");
await evalJs(`document.querySelector('[data-testid="trash-button"]').click()`);
await sleep(500);
out.backToTree = (await rowCount()) > 0;
assert(out.backToTree, "back to workspace tree");

// 6. 行详情面板：打开 grid 视图 → 点主列打开详情按钮 → 面板出现且属性行渲染 → 关闭
const grid = await evalJs(`(async () => {
  const inv = window.__TAURI_INTERNALS__.invoke;
  const wss = await inv('workspace_list', {});
  for (const w of wss) {
    const views = await inv('view_list_by_workspace', { workspaceId: w.id });
    const g = views.find(v => v.layout === 'grid' && !v.is_trash && !(v.extra || '').includes('row_detail'));
    if (g) return { id: g.id, name: g.name };
  }
  return null;
})()`);
out.grid = grid;
if (grid) {
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
  out.detailOpen = await evalJs(`!!document.querySelector('[data-testid="close-row-detail"]')`);
  assert(out.detailOpen, "row detail panel opens");
  out.propFields = await evalJs(`document.querySelectorAll('span.w-20.shrink-0').length`);
  assert(out.propFields > 0, "row detail property fields render, got " + out.propFields);
  await evalJs(`document.querySelector('[data-testid="close-row-detail"]').click()`);
  await sleep(400);
  out.detailClosed = await evalJs(`!document.querySelector('[data-testid="close-row-detail"]')`);
  assert(out.detailClosed, "row detail panel closes");
} else {
  console.log("skip - no grid view in db");
}

// 7. 清理：删除全部「无标题页面」临时行（含本次新建的）
out.postCleaned = await cleanupTemp("post");
out.childrenFinal = await childCountOf(root0);
assert(out.childrenFinal === out.childrenBefore, "temp subpages deleted, root0 children back to baseline");

assert(exceptions.length === 0, "no runtime exceptions during smoke" + (exceptions.length ? ": " + exceptions.join(" | ") : ""));
console.log("SMOKE PASS " + JSON.stringify(out));
