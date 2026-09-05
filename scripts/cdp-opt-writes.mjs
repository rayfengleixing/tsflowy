// P2 优化验证：列宽拖拽单次落库 + 页面属性防抖落库。
// 观测方式：CDP Network 域监听 Tauri IPC 请求（http://ipc.localhost/<命令>），页面内零打点。
// 前置: WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 npm run tauri dev
// 用法: node scripts/cdp-opt-writes.mjs
const BASE = "http://127.0.0.1:9222";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`${BASE}/json`)).json();
const page = list.find((x) => x.type === "page");
if (!page) throw new Error("NO_PAGE");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let msgId = 0;
const pending = new Map();
const ipcLog = []; // { cmd, method }
ws.onmessage = (e) => {
  const d = JSON.parse(e.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); return; }
  if (d.method === "Network.requestWillBeSent") {
    const url = d.params.request.url;
    if (url.includes("ipc.localhost")) {
      const cmd = decodeURIComponent(url.split("ipc.localhost/")[1] ?? "");
      ipcLog.push({ cmd, method: d.params.request.method });
    }
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
const insertText = (t) => cdp("Input.insertText", { text: t });
const mouse = (type, x, y, extra = {}) => cdp("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, ...extra });
const rectOf = async (sel) => evalJs("(() => { const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()");
const clickAt = async (x, y, wait = 300) => {
  await mouse("mouseMoved", x, y);
  await sleep(100);
  await mouse("mousePressed", x, y);
  await mouse("mouseReleased", x, y);
  await sleep(wait);
};
const clickText = async (text, wait = 400) => {
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
const treeIds = () => evalJs("[...document.querySelectorAll('[data-view-id]')].map(e => e.getAttribute('data-view-id'))");
const countIpc = (from, cmd) => ipcLog.slice(from).filter((x) => x.cmd === cmd && x.method === "POST").length;
const ipcSummary = (from) => {
  const m = {};
  for (const x of ipcLog.slice(from)) if (x.method === "POST") m[x.cmd] = (m[x.cmd] ?? 0) + 1;
  return m;
};

const out = {};
try {
  await cdp("Network.enable", { maxPostDataSize: 0 });

  // 0. 等应用就绪
  for (let i = 0; i < 60; i++) {
    if (await evalJs("!!window.__TAURI_INTERNALS__ && !!document.querySelector('[data-view-id]')")) break;
    await sleep(500);
  }

  // ---------- 2. 列宽拖拽：拖拽窗口内只应 1 次 field_set_width ----------
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
  if (!grid) throw new Error("NO_GRID_VIEW");
  out.gridOpened = await evalJs(`(() => {
    const el = [...document.querySelectorAll('[data-view-id]')].find(e => e.textContent.includes(${JSON.stringify(grid.name)}));
    if (!el) return false;
    el.click();
    return true;
  })()`);
  await sleep(1000);

  const handle = await evalJs(`(() => {
    const h = document.querySelector('[data-testid^="resize-"]');
    if (!h) return null;
    const fieldId = h.getAttribute('data-testid').slice(7);
    const col = document.querySelector('col[data-field-id="' + fieldId + '"]');
    const r = h.getBoundingClientRect();
    return { fieldId, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), colWidthBefore: col ? col.style.width : null };
  })()`);
  out.handle = handle;
  if (!handle) throw new Error("NO_RESIZE_HANDLE");

  out.widthBefore = await evalJs(`(async () => {
    const fields = await window.__TAURI_INTERNALS__.invoke('field_list', { viewId: ${JSON.stringify(grid.id)} });
    return fields.find(f => f.id === ${JSON.stringify(handle.fieldId)})?.width ?? null;
  })()`);

  await mouse("mouseMoved", handle.x, handle.y); // 悬停（不能先点击：press+release 会立刻提交一次宽度）
  await sleep(150);
  const dragMark = ipcLog.length;
  await mouse("mousePressed", handle.x, handle.y);
  await sleep(120);
  for (let i = 1; i <= 12; i++) await mouse("mouseMoved", handle.x + i * 5, handle.y);
  await mouse("mouseReleased", handle.x + 60, handle.y);
  await sleep(600);

  out.fieldSetWidthCount = countIpc(dragMark, "field_set_width");
  out.dragWindowIpc = ipcSummary(dragMark);
  out.colWidthAfter = await evalJs(`(() => { const col = document.querySelector('col[data-field-id="${handle.fieldId}"]'); return col ? col.style.width : null; })()`);
  out.widthPersisted = await evalJs(`(async () => {
    const fields = await window.__TAURI_INTERNALS__.invoke('field_list', { viewId: ${JSON.stringify(grid.id)} });
    return fields.find(f => f.id === ${JSON.stringify(handle.fieldId)})?.width ?? null;
  })()`);

  // ---------- 3. 页面属性：6 次键击防抖后只应 1 次 pp_set；失焦立即冲刷 ----------
  const beforeIds = await treeIds();
  out.newPageMenu = await clickText("新建页面", 400);
  out.docMenuItem = await clickText("文档", 900);
  const afterIds = await treeIds();
  const newIds = afterIds.filter((id) => !beforeIds.includes(id));
  out.newDocId = newIds[0] ?? null;
  if (!out.newDocId) throw new Error("NO_NEW_DOC_ID");

  const editorPt = await rectOf(".tiptap");
  if (!editorPt) throw new Error("NO_EDITOR");
  await clickAt(editorPt.x, editorPt.y, 300);
  await insertText("# ");
  await sleep(300);
  await insertText("属性验证页");
  await sleep(700);
  out.slotAppeared = await evalJs("!!document.querySelector('[data-page-properties-slot]')");
  if (!out.slotAppeared) throw new Error("NO_PROPS_SLOT");

  out.addPropertyClicked = await clickText("添加属性", 400);
  await evalJs(`(() => {
    const input = [...document.querySelectorAll('input')].find(i => i.offsetParent !== null && i.placeholder === '属性名…');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '备注');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  out.confirmClicked = await clickText("确认", 500);
  out.propRowAdded = await evalJs("!![...document.querySelectorAll('[data-page-properties-slot] input')].find(i => i.placeholder === '值' && i.offsetParent !== null)");

  // 逐字输入 6 个字符（每字一次 onChange），等防抖窗口过去
  const typeMark = ipcLog.length;
  const valPt = await evalJs(`(() => {
    const i = [...document.querySelectorAll('[data-page-properties-slot] input')].find(i => i.placeholder === '值' && i.offsetParent !== null);
    if (!i) return null;
    const r = i.getBoundingClientRect();
    return { x: Math.round(r.x + Math.min(60, r.width / 2)), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (!valPt) throw new Error("NO_VALUE_INPUT");
  await clickAt(valPt.x, valPt.y, 200);
  for (const ch of ["你", "好", "世", "界", "测", "试"]) {
    await insertText(ch);
    await sleep(150);
  }
  await sleep(1100); // > 500ms 防抖
  const blurMark = ipcLog.length;
  out.ppSetTyped = countIpc(typeMark, "pp_set");
  out.typeWindowIpc = ipcSummary(typeMark);
  out.ppListTyped = await evalJs(`window.__TAURI_INTERNALS__.invoke('pp_list', { viewId: ${JSON.stringify(out.newDocId)} })`);

  // 失焦立即冲刷：再输 1 字符，马上点编辑器空白处
  const editorPt2 = await rectOf(".tiptap");
  await insertText("x");
  await clickAt(editorPt2.x, editorPt2.y, 350);
  out.ppSetBlurWindow = countIpc(blurMark, "pp_set");
  out.ppListBlur = await evalJs(`window.__TAURI_INTERNALS__.invoke('pp_list', { viewId: ${JSON.stringify(out.newDocId)} })`);
} catch (e) {
  out.error = String(e);
}

ws.close();
console.log(JSON.stringify(out, null, 1));
process.exit(0);
