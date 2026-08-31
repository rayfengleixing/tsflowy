// M4 Grid 验收冒烟：字段/行/单元格/排序/筛选/隐藏列/行详情/持久化 全流程验证。
// 用法: node scripts/cdp-m4-grid.mjs
const BASE = "http://127.0.0.1:9222";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`${BASE}/json`)).json();
const page = list.find((x) => x.type === "page");
if (!page) throw new Error("NO_PAGE");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let msgId = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const d = JSON.parse(e.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
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
const key = (k, opts = {}) =>
  cdp("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: opts.code ?? k, windowsVirtualKeyCode: opts.vk ?? k.toUpperCase().charCodeAt(0), modifiers: opts.modifiers ?? 0 })
    .then(() => cdp("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: opts.code ?? k, windowsVirtualKeyCode: opts.vk ?? k.toUpperCase().charCodeAt(0), modifiers: opts.modifiers ?? 0 }));
const insertText = (t) => cdp("Input.insertText", { text: t });
const mouse = (type, x, y, extra = {}) => cdp("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, ...extra });
const rectOf = async (sel) => evalJs("(() => { const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) }; })()");
// 在页面里执行 "document.querySelector(<sel>) 存在时的操作体"，body 为函数体字符串
const withEl = async (sel, body) =>
  evalJs("(() => { const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return false; " + body + " return true; })()");
const clickAt = async (sel, wait = 400) => {
  const pt = await rectOf(sel);
  if (!pt) return false;
  await mouse("mouseMoved", pt.x, pt.y);
  await sleep(120);
  await mouse("mousePressed", pt.x, pt.y);
  await mouse("mouseReleased", pt.x, pt.y);
  await sleep(wait);
  return true;
};
const setSelect = async (sel, value) =>
  evalJs("(() => { const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set; setter.call(el, " + JSON.stringify(value) + "); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()");

const out = {};

// ---------- 0. 确保打开一个 grid 视图 ----------
// 等应用就绪
for (let i = 0; i < 40; i++) {
  if (await evalJs("!!document.querySelector('[data-view-id]')")) break;
  await sleep(500);
}
// 找现有 grid 视图（树里 layout 无法直接判断，直接新建一个）
const gridName = "验收表";
const created = await evalJs(`(async () => {
  const items = [...document.querySelectorAll('[data-view-id]')];
  const existing = items.find((el) => el.textContent.includes('${gridName}'));
  if (existing) { existing.click(); return 'EXISTS'; }
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('新建页面'));
  if (!btn) return 'NO_NEWBTN';
  btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  btn.click();
  await new Promise((r) => setTimeout(r, 300));
  const item = [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.includes('表格'));
  if (!item) return 'NO_GRID_ITEM: ' + [...document.querySelectorAll('[role=menuitem]')].map(m => m.textContent.trim()).join('|');
  item.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  item.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  item.click();
  return 'CREATED';
})()`);
out.gridCreated = created;
await sleep(900);

// 重命名视图为验收表（双击标题改名，带重试）
for (let attempt = 0; attempt < 3; attempt++) {
  await evalJs(`(() => {
    const h1 = [...document.querySelectorAll('h1')].find(h => h.textContent.includes('无标题页面') || h.textContent.includes('Untitled'));
    if (!h1) return false;
    h1.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return true;
  })()`);
  await sleep(400);
  const inputShown = await evalJs("!!document.querySelector('h1 + input') || [...document.querySelectorAll('input')].some(i => i.offsetParent !== null)");
  if (inputShown) {
    await evalJs(`(() => {
      const input = [...document.querySelectorAll('input')].find(i => i.offsetParent !== null);
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '${gridName}');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    })()`);
    break;
  }
}
await sleep(600);
out.renamed = await evalJs("document.body.innerText.includes('" + gridName + "')");

// 表格渲染检查
out.gridRendered = await evalJs("!!document.querySelector('table') && !!document.querySelector('[data-testid=add-row]')");

// ---------- 1. 添加字段 ----------
const addField = async (name, typeBtn) => {
  await clickAt('[data-testid="add-field"]', 300);
  if (typeBtn) {
    // 快捷类型按钮
    const ok = await evalJs("(() => { const btns = [...document.querySelectorAll('[data-testid=add-field]')]; return true; })()");
    void ok;
    const clicked = await evalJs("(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === " + JSON.stringify(typeBtn) + "); if (!btn) return false; btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); btn.click(); return true; })()");
    await sleep(400);
    return clicked;
  }
  // 输入名字 → Enter（默认文本字段）
  await withEl('input[placeholder*="字段名称"]', "const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(el, " + JSON.stringify(name) + "); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));");

  await sleep(400);
  return true;
};

out.addFieldText = await addField("任务", null);
out.addFieldNumber = await addField("", "数字");
out.addFieldDate = await addField("", "日期");
out.addFieldCheckbox = await addField("", "复选框");
out.addFieldSelect = await addField("", "单选");

const headers = await evalJs("[...document.querySelectorAll('thead th')].map(t => t.textContent.trim()).filter(Boolean)");
out.headers = headers;

// ---------- 2. 新建行 ----------
await clickAt('[data-testid="add-row"]', 400);
await clickAt('[data-testid="add-row"]', 400);
out.rowsAfterAdd = await evalJs("document.querySelectorAll('tbody tr').length");

// ---------- 3. 单元格编辑 ----------
// 第一行"任务"列：点击单元格 → 输入 → Enter
const cellPt = await evalJs("(() => { const td = document.querySelector('tbody tr td:nth-child(2)'); if (!td) return null; const r = td.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()");
if (cellPt) {
  await mouse("mouseMoved", cellPt.x, cellPt.y);
  await sleep(150);
  await mouse("mousePressed", cellPt.x, cellPt.y);
  await mouse("mouseReleased", cellPt.x, cellPt.y);
  await sleep(400);
  out.cellEditorShown = await evalJs("!!document.querySelector('tbody td input')");
  await insertText("写周报");
  await sleep(150);
  await key("Enter", { code: "Enter", vk: 13 });
  await sleep(500);
  out.textCommitted = await evalJs("document.querySelector('tbody')?.innerText.includes('写周报')");
}
// 复选框列（第 5 列）点击切换
const cbPt = await evalJs("(() => { const td = document.querySelector('tbody tr td:nth-child(5)'); if (!td) return null; const r = td.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()");
if (cbPt) {
  await mouse("mouseMoved", cbPt.x, cbPt.y);
  await sleep(120);
  await mouse("mousePressed", cbPt.x, cbPt.y);
  await mouse("mouseReleased", cbPt.x, cbPt.y);
  await sleep(400);
  // 第二次点击切换复选框
  await mouse("mouseMoved", cbPt.x, cbPt.y);
  await sleep(120);
  await mouse("mousePressed", cbPt.x, cbPt.y);
  await mouse("mouseReleased", cbPt.x, cbPt.y);
  await sleep(500);
  out.checkboxToggled = await evalJs("document.querySelector('tbody tr td:nth-child(5)')?.innerText.includes('✓')");
}
// 单选列（第 6 列）：点击 → 选项菜单 → 选第一个选项
const selPt = await evalJs("(() => { const td = document.querySelector('tbody tr td:nth-child(6)'); if (!td) return null; const r = td.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()");
if (selPt) {
  await mouse("mouseMoved", selPt.x, selPt.y);
  await sleep(120);
  await mouse("mousePressed", selPt.x, selPt.y);
  await mouse("mouseReleased", selPt.x, selPt.y);
  await sleep(500);
  out.selectMenuShown = await evalJs("document.body.innerText.includes('暂无选项')");
  // 单选字段暂无选项——关闭
  await key("Escape", { code: "Escape", vk: 27 });
  await sleep(300);
}

// ---------- 3.5 字段重命名（菜单 → 重命名 → 输入 → Enter） ----------
await evalJs("(() => { const th = [...document.querySelectorAll('thead th')].find(t => t.textContent.includes('任务')); if (!th) return false; const btn = th.querySelector('[data-testid=field-menu]'); if (!btn) return false; btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); btn.click(); return true; })()");
await sleep(500);
const renameItem = await evalJs("(() => { const item = [...document.querySelectorAll('[role=menuitem]')].find(m => m.textContent.includes('重命名')); if (!item) return false; item.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); item.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); item.click(); return true; })()");
await sleep(400);
const renamedField = await evalJs("(() => { const input = document.querySelector('thead input'); if (!input) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(input, '任务描述'); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()");
await sleep(500);
out.fieldRenamed = renamedField && (await evalJs("document.querySelector('thead')?.innerText.includes('任务描述')"));

// ---------- 3.6 列宽拖拽（真实鼠标：number 列手柄 +100px，失败重试一次） ----------
await sleep(600); // 等 3.5 重命名的 React 重渲染稳定
const widthBefore = await evalJs("(() => { const th = [...document.querySelectorAll('thead th')].find(t => t.textContent.includes('number')); return th ? th.offsetWidth : -1; })()");
let resized = false;
for (let attempt = 0; attempt < 2 && !resized; attempt++) {
  const handlePt = await evalJs("(() => { const th = [...document.querySelectorAll('thead th')].find(t => t.textContent.includes('number')); if (!th) return null; const h = th.querySelector('[data-testid^=resize-]'); if (!h) return null; const r = h.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()");
  if (!handlePt || widthBefore <= 0) break;
  await mouse("mouseMoved", handlePt.x, handlePt.y);
  await sleep(250);
  await mouse("mousePressed", handlePt.x, handlePt.y);
  await sleep(400);
  for (let i = 1; i <= 5; i++) {
    await mouse("mouseMoved", handlePt.x + i * 20, handlePt.y);
    await sleep(150);
  }
  await mouse("mouseReleased", handlePt.x + 100, handlePt.y);
  await sleep(800);
  const widthAfter = await evalJs("(() => { const th = [...document.querySelectorAll('thead th')].find(t => t.textContent.includes('number')); return th ? th.offsetWidth : -1; })()");
  resized = widthAfter > widthBefore + 50;
  out.columnResized = { before: widthBefore, after: widthAfter, ok: resized, attempt };
}
if (!resized) out.columnResized = { before: widthBefore, after: widthBefore, ok: false, note: "resize retries exhausted" };

// ---------- 3.7 选项管理：单选字段添加选项"进行中" ----------
await evalJs("(() => { const th = [...document.querySelectorAll('thead th')].find(t => t.textContent.includes('single_select')); if (!th) return false; const btn = th.querySelector('[data-testid=field-menu]'); if (!btn) return false; btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); btn.click(); return true; })()");
await sleep(500);
await evalJs("(() => { const item = [...document.querySelectorAll('[role=menuitem]')].find(m => m.textContent.includes('字段设置')); if (!item) return false; item.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); item.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); item.click(); return true; })()");
await sleep(600);
const optionAdded = await evalJs("(() => { const input = [...document.querySelectorAll('[role=dialog] input')].find(i => i.placeholder.includes('新选项')); if (!input) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(input, '进行中'); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()");
await sleep(400);
out.optionAddedInDialog = optionAdded && (await evalJs("[...document.querySelectorAll('[role=dialog] input')].some(i => i.value === '进行中')"));
// 保存对话框
await evalJs("(() => { const btn = [...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent.trim() === '确认'); if (!btn) return false; btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); btn.click(); return true; })()");
await sleep(500);
// 验证：点单选单元格 → 菜单出现"进行中"
const selPt2 = await evalJs("(() => { const td = document.querySelector('tbody tr td:nth-child(6)'); if (!td) return null; const r = td.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()");
if (selPt2) {
  await mouse("mouseMoved", selPt2.x, selPt2.y);
  await sleep(120);
  await mouse("mousePressed", selPt2.x, selPt2.y);
  await mouse("mouseReleased", selPt2.x, selPt2.y);
  await sleep(500);
  out.optionVisibleInMenu = await evalJs("document.body.innerText.includes('进行中')");
  // 选择"进行中"
  await evalJs("(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '进行中'); if (!btn) return false; btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); btn.click(); return true; })()");
  await sleep(500);
  out.selectValueCommitted = await evalJs("document.querySelector('tbody tr td:nth-child(6)')?.innerText.includes('进行中')");
}

// ---------- 3.8 CSV 命令验证（read_text_file / write_text_file 走通） ----------
const csvIpc = await evalJs(`(async () => {
  const inv = window.__TAURI_INTERNALS__?.invoke;
  try {
    const tmp = 'C:/Users/Fang/AppData/Local/Temp/cdp-m4-test.csv';
    const payload = 'a,b' + String.fromCharCode(13, 10) + '1,2';
    await inv('write_text_file', { path: tmp, content: payload });
    const back = await inv('read_text_file', { path: tmp });
    return { ok: back === payload, back };
  } catch (e) { return { err: String(e) }; }
})()`);
out.csvCommands = csvIpc;

// ---------- 4. 排序：点击"任务"表头 ----------
const headClicked = await evalJs("(() => { const th = [...document.querySelectorAll('thead th')].find(t => t.textContent.includes('任务')); if (!th) return false; const div = th.querySelector('div'); if (!div) return false; div.click(); return true; })()");
await sleep(500);
out.sortIndicator = headClicked && (await evalJs("document.querySelector('thead')?.innerText.includes('↑') || document.querySelector('thead')?.innerText.includes('↓')"));

// ---------- 5. 筛选 ----------
const filterClicked = await evalJs("(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('筛选')); if (!btn) return false; btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); btn.click(); return true; })()");
await sleep(500);
out.filterBarShown = filterClicked && (await evalJs("document.body.innerText.includes('添加条件')"));
if (out.filterBarShown) {
  // 添加条件（第一个字段 + 默认操作符）
  await evalJs("(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('添加条件')); if (!btn) return false; btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); btn.click(); return true; })()");
  await sleep(400);
  out.filterConditionAdded = await evalJs("document.querySelectorAll('select').length >= 2");
  // 关闭筛选
  await evalJs("(() => { const btn = [...document.querySelectorAll('button')].find(b => b.querySelector('svg') && b.textContent === '' && b.className.includes('ml-auto')); if (!btn) return false; btn.click(); return true; })()");
  await sleep(300);
}

// ---------- 6. 隐藏列（任务列菜单 → 隐藏列） ----------
await evalJs("(() => { const th = [...document.querySelectorAll('thead th')].find(t => t.textContent.includes('任务')); if (!th) return false; const btn = th.querySelector('[data-testid=field-menu]'); if (!btn) return false; btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); btn.click(); return true; })()");
await sleep(500);
const hideClicked = await evalJs("(() => { const item = [...document.querySelectorAll('[role=menuitem]')].find(m => m.textContent.includes('隐藏列')); if (!item) return false; item.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); item.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); item.click(); return true; })()");
await sleep(500);
out.fieldHidden = hideClicked && !(await evalJs("document.querySelector('thead')?.innerText.includes('任务')"));

// ---------- 6.5 清空筛选（保证行详情步骤看到全部行） ----------
await evalJs("(() => { const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('筛选')); if (!btn) return false; btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); btn.click(); return true; })()");
await sleep(500);
out.dbg1 = await evalJs("({ hasTable: !!document.querySelector('table'), h1: document.querySelector('h1')?.textContent })");
await evalJs("(() => { const bar = document.querySelector('[data-testid=filter-bar]'); if (!bar) return -1; const trash = [...bar.querySelectorAll('button')].filter(b => b.querySelector('svg')?.classList.contains('lucide-trash-2')); for (const b of trash) { b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); b.click(); } return trash.length; })()");
await sleep(500);
out.dbg2 = await evalJs("({ hasTable: !!document.querySelector('table'), h1: document.querySelector('h1')?.textContent })");
// 关闭筛选条
await evalJs("(() => { const bar = document.querySelector('[data-testid=filter-bar]'); const xBtn = bar ? [...bar.querySelectorAll('button')].find(b => b.querySelector('svg')?.classList.contains('lucide-x')) : null; if (!xBtn) return false; xBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); xBtn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); xBtn.click(); return true; })()");
await sleep(400);
out.dbg3 = await evalJs("({ hasTable: !!document.querySelector('table'), h1: document.querySelector('h1')?.textContent })");
out.filtersCleared = await evalJs("!document.body.innerText.includes('个筛选条件生效')");

// ---------- 7. 行详情：双击第一行 ----------
out.preRowDetail = await evalJs("({ trs: document.querySelectorAll('tbody tr').length, hasFilter: document.body.innerText.includes('个筛选条件生效'), hasTable: !!document.querySelector('table') })");
let rowDbl = false;
for (let attempt = 0; attempt < 3; attempt++) {
  rowDbl = await evalJs("(() => { const tr = [...document.querySelectorAll('tbody tr')].find(tr => tr.querySelector('td:first-child')?.textContent.trim() !== ''); const td = tr?.querySelector('td:nth-child(2)'); if (!td) return false; td.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true; })()");
  await sleep(1500);
  if (await evalJs("!!document.querySelector('[data-testid=close-row-detail]')")) break;
}
if (rowDbl) {
  out.rowDetailOpened = await evalJs("!!document.querySelector('[data-testid=close-row-detail]') && !!document.querySelector('.tiptap')");
  if (out.rowDetailOpened) {
    // 在行详情文档里输入内容
    await evalJs("document.querySelector('.tiptap')?.focus()");
    await sleep(300);
    await insertText("行详情笔记内容ABC");
    await sleep(400);
    out.rowDetailTyped = await evalJs("document.querySelector('.tiptap')?.innerText.includes('行详情笔记内容ABC')");
    await sleep(1200); // 自动保存
    // 关闭面板
    await clickAt('[data-testid="close-row-detail"]', 500);
    out.rowDetailClosed = await evalJs("!document.querySelector('[data-testid=close-row-detail]')");
    // 重开 → 内容保留
    const reopened = await evalJs("(() => { const td = document.querySelector('tbody tr td:nth-child(3)'); if (!td) return false; td.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true; })()");
    if (reopened) {
      await sleep(2000);
      out.rowDetailPersisted = await evalJs("document.querySelector('.tiptap')?.innerText.includes('行详情笔记内容ABC')");
      await clickAt('[data-testid="close-row-detail"]', 400);
    }
  }
}

// ---------- 8. 持久化：重载页面 → 重新打开验收表 → 数据在 ----------
await cdp("Page.reload");
await sleep(2500);
for (let i = 0; i < 30; i++) {
  if (await evalJs("!!document.querySelector('[data-view-id]')")) break;
  await sleep(500);
}
await evalJs("(() => { const items = [...document.querySelectorAll('[data-view-id]')]; const el = items.find(x => x.textContent.includes('" + gridName + "')) ?? items[0]; if (el) { const o = { bubbles: true, cancelable: true, pointerType: 'mouse', button: 0 }; el.dispatchEvent(new PointerEvent('pointerdown', o)); el.dispatchEvent(new PointerEvent('pointerup', o)); el.click(); } return true; })()");
await sleep(900);
const persisted = await evalJs("({ hasTable: !!document.querySelector('table'), text: document.querySelector('tbody')?.innerText ?? '', headers: [...document.querySelectorAll('thead th')].map(t => t.textContent.trim()).filter(Boolean) })");
// 用应用 IPC 直查数据库确认单元格/行/字段持久化（不受隐藏列影响）
const dbCheck = await evalJs(`(async () => {
  const inv = window.__TAURI_INTERNALS__?.invoke;
  const sel = async (query, values = []) => inv('plugin:sql|select', { db: 'sqlite:appflowy.db', query, values });
  try {
    const fields = await sel("SELECT name, field_type FROM database_fields ORDER BY position");
    const cells = await sel("SELECT c.value FROM database_cells c JOIN database_fields f ON f.id = c.field_id WHERE f.name = '任务描述'");
    const rows = await sel("SELECT COUNT(*) AS n FROM database_rows");
    const rowDocs = await sel("SELECT COUNT(*) AS n FROM database_rows WHERE document_id IS NOT NULL");
    return { fields, hasTextCell: cells.some(c => c.value.includes('写周报')), rowCount: rows[0].n, rowDocs: rowDocs[0].n };
  } catch (e) { return { err: String(e) }; }
})()`);
out.dbPersisted = dbCheck;

ws.close();
console.log(JSON.stringify(out, null, 1));
process.exit(0);