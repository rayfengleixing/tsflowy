// 阶段1 验证：视图配置（显示模式 / 排序 / 看板分组字段）持久化到 views.extra，并在页面重载后恢复。
// 观测方式：CDP 驱动真实 UI 操作 + 直接 invoke 读库核对，页面内零打点。
// 前置: WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 npm run tauri dev
// 用法: node scripts/cdp-view-config-smoke.mjs
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
  if (d.id && pending.has(d.id)) {
    pending.get(d.id)(d);
    pending.delete(d.id);
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
  if (r.exceptionDetails)
    throw new Error("EVAL: " + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails));
  return r.result?.value;
};
const mouse = (type, x, y, extra = {}) =>
  cdp("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, ...extra });
const clickAt = async (x, y, wait = 300) => {
  await mouse("mouseMoved", x, y);
  await sleep(100);
  await mouse("mousePressed", x, y);
  await mouse("mouseReleased", x, y);
  await sleep(wait);
};
// 按可见文本点按钮（radix / 受控组件都要求真实鼠标事件）
const clickText = async (text, wait = 400) => {
  const pt = await evalJs(`(() => {
    const all = [...document.querySelectorAll('button')].filter(x => x.offsetParent !== null && x.textContent.trim() === ${JSON.stringify(text)});
    const el = all[0] ?? [...document.querySelectorAll('button')].find(x => x.offsetParent !== null && x.textContent.includes(${JSON.stringify(text)}));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (!pt) return false;
  await clickAt(pt.x, pt.y, wait);
  return true;
};
const ready = () =>
  evalJs("!!window.__TAURI_INTERNALS__ && !!document.querySelector('[data-view-id]')");
const extraOf = (viewId) =>
  evalJs(`(async () => {
    const wss = await window.__TAURI_INTERNALS__.invoke('workspace_list', {});
    for (const w of wss) {
      const views = await window.__TAURI_INTERNALS__.invoke('view_list_by_workspace', { workspaceId: w.id });
      const v = views.find(x => x.id === ${JSON.stringify(viewId)});
      return v ? v.extra : null;
    }
    return null;
  })()`);
const treeCount = () => evalJs("document.querySelectorAll('[data-view-id]').length");

const out = { steps: [] };
const step = (name, value) => out.steps.push(`${name}=${typeof value === "string" ? value : JSON.stringify(value)}`);

async function waitFor(fn, tries = 40, ms = 500) {
  for (let i = 0; i < tries; i++) {
    try {
      if (await fn()) return true;
    } catch {
      /* 页面上下文正在重建，下一轮再试 */
    }
    await sleep(ms);
  }
  return false;
}

try {
  // 0. 等应用就绪
  if (!(await waitFor(ready))) throw new Error("APP_NOT_READY");

  // 1. 找一个 grid 数据库视图（排除行详情文档）
  let grid = await evalJs(`(async () => {
    const inv = window.__TAURI_INTERNALS__.invoke;
    const wss = await inv('workspace_list', {});
    for (const w of wss) {
      const views = await inv('view_list_by_workspace', { workspaceId: w.id });
      const g = views.find(v => v.layout === 'grid' && !v.is_trash && !(v.extra || '').includes('row_detail'));
      if (g) return { id: g.id, name: g.name, extra: g.extra };
    }
    return null;
  })()`);
  if (!grid) {
    // 数据库是干净的：自建一张带 名称 + 单选 字段的表，再重载让前端树/存储看到它
    out.provisioned = await evalJs(`(async () => {
      const inv = window.__TAURI_INTERNALS__.invoke;
      const wss = await inv('workspace_list', {});
      if (!wss.length) return 'NO_WORKSPACE';
      const viewId = crypto.randomUUID();
      await inv('view_create', { id: viewId, workspaceId: wss[0].id, parentId: null, name: '配置持久化验证表', layout: 'grid', extra: null });
      await inv('field_create', { viewId, id: crypto.randomUUID(), fieldType: 'text', name: '名称' });
      const fieldId = crypto.randomUUID();
      await inv('field_create', { viewId, id: fieldId, fieldType: 'single_select', name: '状态' });
      const opt = (name) => ({ id: 'opt_' + crypto.randomUUID().slice(0, 8), name, color: 'blue' });
      await inv('field_update_options', { fieldId, options: JSON.stringify({ kind: 'select', options: [opt('待办'), opt('进行中')] }) });
      await inv('row_create', { viewId, id: crypto.randomUUID() });
      await inv('row_create', { viewId, id: crypto.randomUUID() });
      return viewId;
    })()`);
    if (typeof out.provisioned !== "string" || out.provisioned.startsWith("NO_")) throw new Error("PROVISION_FAILED");
    cdp("Runtime.evaluate", { expression: "location.reload()", awaitPromise: false }).catch(() => {});
    await sleep(3000);
    if (!(await waitFor(ready))) throw new Error("RELOAD_AFTER_PROVISION_FAILED");
    const found = await evalJs(`(async () => {
      const inv = window.__TAURI_INTERNALS__.invoke;
      const wss = await inv('workspace_list', {});
      for (const w of wss) {
        const views = await inv('view_list_by_workspace', { workspaceId: w.id });
        const g = views.find(v => v.id === ${JSON.stringify(out.provisioned)});
        if (g) return { id: g.id, name: g.name, extra: g.extra };
      }
      return null;
    })()`);
    if (!found) throw new Error("PROVISIONED_VIEW_MISSING");
    grid = found;
  }
  out.viewId = grid.id;
  out.extraBefore = grid.extra;
  const beforeKeys = Object.keys(JSON.parse(grid.extra || "{}"));

  // 1b. 至少两个单选字段：看板会把"第一个单选字段"当默认分组且不落库，
  //     只有一个字段时无法区分"从 extra 恢复"和"默认值"。
  out.selectTopUp = await evalJs(`(async () => {
    const inv = window.__TAURI_INTERNALS__.invoke;
    const fields = await inv('field_list', { viewId: ${JSON.stringify(grid.id)} });
    let have = fields.filter(f => f.field_type === 'single_select').length;
    let made = 0;
    while (have < 2) {
      await inv('field_create', { viewId: ${JSON.stringify(grid.id)}, id: crypto.randomUUID(), fieldType: 'single_select', name: '状态' + (have + 1) });
      have++; made++;
    }
    return made;
  })()`);

  // 1c. 每轮从干净上下文开始：前端 extra 缓存在一次会话内是权威副本，
  //     不重载就分不清"读到库里的值"和"读到上一轮写进缓存的值"。
  cdp("Runtime.evaluate", { expression: "location.reload()", awaitPromise: false }).catch(() => {});
  await sleep(3000);
  if (!(await waitFor(ready))) throw new Error("RELOAD_AT_START_FAILED");

  // 2. 打开该视图
  out.treeNodesBefore = await treeCount();
  const opened = await evalJs(`(() => {
    const el = document.querySelector('[data-view-id="${grid.id}"]');
    if (!el) return false;
    el.click();
    return true;
  })()`);
  if (!opened) throw new Error("VIEW_NOT_IN_TREE");
  await sleep(1200);
  // 上一次运行持久化的 mode 可能是看板/日历，先归一到表格再操作列头
  out.reopenedModeFromExtra = await evalJs(`(() => {
    const names = ['表格', '看板', '日历'];
    const btns = [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null);
    return names.find(n => btns.some(b => b.textContent.trim() === n && /bg-brand-100/.test(b.className))) ?? null;
  })()`);
  await clickText("表格", 600);
  if (!(await waitFor(() => evalJs("!!document.querySelector('table thead tr')")))) throw new Error("GRID_NOT_RENDERED");

  // 3. 点列头 → 升序排序，应写入 extra.sorts
  const header = await evalJs(`(() => {
    const th = [...document.querySelectorAll('thead th')][2] ?? [...document.querySelectorAll('thead th')][1];
    const div = th && th.querySelector('div');
    if (!div) return null;
    const r = div.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (!header) throw new Error("NO_COLUMN_HEADER");
  let sortWritten = null;
  for (let i = 0; i < 3; i++) {
    await clickAt(header.x, header.y, 900);
    out.extraAfterSort = await extraOf(grid.id);
    sortWritten = JSON.parse(out.extraAfterSort ?? "{}").sorts;
    if (sortWritten?.length) break;
  }
  step("sorts", sortWritten);

  // 3b. 筛选条件 → extra.filters + filterMode
  if (!(await clickText("筛选", 500))) throw new Error("NO_FILTER_TOGGLE");
  if (!(await clickText("添加条件", 800))) throw new Error("NO_ADD_FILTER");
  out.extraAfterFilter = await extraOf(grid.id);
  step("filters", JSON.parse(out.extraAfterFilter ?? "{}").filters);
  // 收起筛选条：它自带两个 select，会干扰后面的分组字段探测
  await clickText("筛选", 500);

  // 4. 切到看板 → extra.mode = board
  if (!(await clickText("看板", 900))) throw new Error("NO_BOARD_TAB");
  out.extraAfterMode = await extraOf(grid.id);
  step("mode", JSON.parse(out.extraAfterMode ?? "{}").mode);

  // 5. 看板分组字段 → extra.boardFieldId（选最后一个单选字段：默认分组是第一个，选它就无法区分）
  const groupSelectProbe = `(() => {
    const sel = [...document.querySelectorAll('select')].find(s => s.offsetParent !== null && [...s.options].some(o => o.value));
    if (!sel) return null;
    const vals = [...sel.options].map(o => o.value).filter(Boolean);
    return { value: sel.value, next: vals[vals.length - 1] ?? null, label: [...sel.options].map(o => o.textContent) };
  })()`;
  out.boardGroupDefault = await evalJs(groupSelectProbe);
  const boardSelect = out.boardGroupDefault;
  if (boardSelect?.next) {
    await evalJs(`(() => {
      const sel = [...document.querySelectorAll('select')].find(s => s.offsetParent !== null && [...s.options].some(o => o.value));
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(sel, ${JSON.stringify(boardSelect.next)});
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await sleep(900);
    out.groupFieldWritten = boardSelect.next;
    out.extraAfterGroup = await extraOf(grid.id);
    step("boardFieldId", JSON.parse(out.extraAfterGroup ?? "{}").boardFieldId);
  } else {
    step("boardFieldId", "SKIPPED_NO_SELECT_FIELD");
  }

  // 6. 停在"看板"：重载后仍应是看板（默认值是 grid，所以这是真实信号）
  const finalExtra = JSON.parse((await extraOf(grid.id)) ?? "{}");
  out.extraFinal = finalExtra;
  step("modeFinal", finalExtra.mode);

  // 7. 未知键必须原样保留（row_detail 过滤依赖 extra，不能被覆盖掉）
  const afterKeys = Object.keys(finalExtra);
  out.foreignKeysKept = beforeKeys.filter((k) => !["mode", "sorts", "filters", "filterMode", "boardFieldId", "calendarFieldId"].includes(k))
    .every((k) => afterKeys.includes(k));

  // 8. 行详情文档仍不出现在树里
  out.treeNodesAfter = await treeCount();

  // 9. 重载 JS 上下文（等同重启应用的首屏读取路径），再打开同一视图
  //    location.reload() 的 evaluate 永不返回 → fire-and-forget
  cdp("Runtime.evaluate", { expression: "location.reload()", awaitPromise: false }).catch(() => {});
  await sleep(3000);
  out.reloaded = await waitFor(ready, 40, 500);
  if (!out.reloaded) throw new Error("RELOAD_FAILED");

  const reopened = await evalJs(`(() => {
    const el = document.querySelector('[data-view-id="${grid.id}"]');
    if (!el) return false;
    el.click();
    return true;
  })()`);
  if (!reopened) throw new Error("REOPEN_FAILED");
  await sleep(1500);

  const activeMode = () =>
    evalJs(`(() => {
      const names = ['表格', '看板', '日历'];
      const btns = [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null);
      return names.find(n => btns.some(b => b.textContent.trim() === n && /bg-brand-100/.test(b.className))) ?? null;
    })()`);

  out.extraAfterReload = JSON.parse((await extraOf(grid.id)) ?? "{}");
  out.restoredMode = await activeMode();
  out.restoredGroupValue = await evalJs(`(() => {
    const sel = [...document.querySelectorAll('select')].find(s => s.offsetParent !== null && [...s.options].some(o => o.value));
    return sel ? sel.value : null;
  })()`);

  // 切回表格：排序箭头应由 extra.sorts 恢复
  await clickText("表格", 900);
  if (!(await waitFor(() => evalJs("!!document.querySelector('table thead tr')")))) throw new Error("GRID_NOT_RESTORED");
  out.restoredModeAfterGridClick = await activeMode();
  out.restoredSortArrow = await evalJs(`(() => {
    const cells = [...document.querySelectorAll('thead th')].map(t => t.textContent);
    return cells.some(c => c.includes('↑') || c.includes('↓'));
  })()`);
  out.restoredFilterBadge = await evalJs(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.offsetParent !== null && x.textContent.includes('筛选'));
    return b ? b.querySelector('span')?.textContent.trim() ?? null : null;
  })()`);

  // 10. 复位：把配置写回默认值，重复运行才有确定的起点
  for (let i = 0; i < 3; i++) {
    await clickAt(header.x, header.y, 700);
    const e = JSON.parse((await extraOf(grid.id)) ?? "{}");
    if (!e.sorts?.length) break;
  }
  await clickText("筛选", 500);
  const trash = await evalJs(`(() => {
    const b = [...document.querySelectorAll('[data-testid="filter-bar"] button')].find(x => x.querySelector('svg[class*="trash"]'));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  out.filterResetClicked = !!trash;
  if (trash) await clickAt(trash.x, trash.y, 700);
  await clickText("筛选", 400);
  await clickText("看板", 600);
  await evalJs(`(() => {
    const sel = [...document.querySelectorAll('select')].find(s => s.offsetParent !== null && [...s.options].some(o => o.value));
    if (!sel) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(sel, "");
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await clickText("表格", 700);
  await sleep(900);
  out.extraReset = await extraOf(grid.id);

  const written = JSON.parse(out.extraAfterGroup ?? "{}").boardFieldId;
  const filtersWritten = JSON.parse(out.extraAfterFilter ?? "{}").filters;
  const reset = JSON.parse(out.extraReset ?? "{}");
  out.checks = {
    "sorts 写入 extra": !!sortWritten?.length,
    "filters 写入 extra": filtersWritten?.length === 1,
    "mode 写入 extra": JSON.parse(out.extraAfterMode ?? "{}").mode === "board",
    "boardFieldId 写入 extra": !!written,
    "所选分组字段不同于默认": !!written && out.boardGroupDefault?.value !== written,
    "未知键未被覆盖": out.foreignKeysKept === true,
    "行详情文档未泄漏到树": out.treeNodesBefore === out.treeNodesAfter,
    "重载后模式恢复为看板": out.restoredMode === "看板",
    "重载后分组字段恢复": !!written && out.restoredGroupValue === written,
    "重载后切回表格生效": out.restoredModeAfterGridClick === "表格",
    "重载后排序恢复": out.restoredSortArrow === true,
    "重载后筛选计数徽标恢复": out.restoredFilterBadge === String(filtersWritten?.length ?? 0),
    "复位后模式/分组/筛选回默认": reset.mode === "grid" && reset.boardFieldId === "" && (!reset.sorts || reset.sorts.length === 0) && (!reset.filters || reset.filters.length === 0),
  };
  out.allPassed = Object.values(out.checks).every(Boolean);
} catch (e) {
  out.error = String(e);
}

ws.close();
console.log(JSON.stringify({ ...out, steps: out.steps }, null, 1));
process.exit(0);
