// 2026-11-01 批「聚合小计补两个宿主」的真机取证：日历日格 + 列表顶栏，两处都复用看板列头那套 AggregateMenu。
// 观测方式：CDP 派发真实鼠标点击 / 原生 select change，落库侧读 views.extra 的新键，渲染侧读那块汇总的展示文本。
// 数据口径：只写自建沙箱表「CDP-agg」（名称刻意不含「小计/汇总」，免得和顶栏文案认错），
//  开跑先清历史残留、收尾 view_purge 硬删（fields/rows/cells 走 FK 级联），可反复运行。
// 语言口径：界面文案中英双写匹配，视图名用 ASCII（ZCDP-*）。
// 前置: WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 npm run tauri dev
// 用法: node scripts/cdp-agg-subtotal-smoke.mjs
const BASE = "http://127.0.0.1:9222";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SCRATCH = "CDP-agg";
const CAL_CHIP = "ZCDP-agg-cal";
const LIST_CHIP = "ZCDP-agg-list";
const pad2 = (n) => String(n).padStart(2, "0");
const NOW = new Date();
/** 界面按本地日期渲染，取「今天」不能用 toISOString()（那是 UTC，月末/深夜会差一天）。 */
const TODAY = `${NOW.getFullYear()}-${pad2(NOW.getMonth() + 1)}-${pad2(NOW.getDate())}`;
/**
 * 丙丁放到**当月另一格**：日历月视图只渲染当月格子（board-calendar.ts 的 buildCalendarMonth 把越界格置成 day:null，
 * 越月的行连桶都进不了），所以「三天后」这种写法每月最后三天必然把丙丁送出可视区。
 * 一格两行也刻意低于折叠阈值（一天 >3 行才折成 2 行 +「+N 更多」），小计读的是整格行集、不受折叠影响，
 * 但锚点得稳定。
 */
const LATER_DAY = NOW.getDate() <= 25 ? 25 : 5;
const LATER = `${NOW.getFullYear()}-${pad2(NOW.getMonth() + 1)}-${pad2(LATER_DAY)}`;
/** 顶栏「小计字段」那个 select 的 aria-label（ListView/CalendarView 共用一条 i18n 键） */
const SUBTOTAL_LABEL = /小计字段|Subtotal by/;
const MENU_ITEM = '[data-slot="dropdown-menu-content"] [data-slot="dropdown-menu-item"]';

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
const inv = (cmd, args) =>
  evalJs(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? {})})`);
const mouse = (type, x, y, extra = {}) =>
  cdp("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, ...extra });
const clickAt = async (x, y, wait = 350) => {
  await mouse("mouseMoved", x, y);
  await sleep(80);
  await mouse("mousePressed", x, y);
  await mouse("mouseReleased", x, y);
  await sleep(wait);
};
const reload = () =>
  ws.send(JSON.stringify({ id: ++msgId, method: "Runtime.evaluate", params: { expression: "location.reload()" } }));
const center = (findExpr) =>
  evalJs(`(() => {
    const el = (${findExpr});
    if (!el) return null;
    if (!el.getBoundingClientRect().width) el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
const ready = () => evalJs("!!window.__TAURI_INTERNALS__ && !!document.querySelector('[data-tree-row]')");

const assert = (cond, msg) => {
  if (!cond) throw new Error("ASSERT: " + msg);
  console.log("ok - " + msg);
};
async function waitFor(fn, desc, tries = 30, gap = 500) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    try {
      if (await fn()) return true;
      last = null;
    } catch (e) {
      last = e;
    }
    await sleep(gap);
  }
  throw new Error(
    "TIMEOUT: " + desc + (last ? " | 最后一轮报错: " + String(last.message).replace(/\s+/g, " ").slice(0, 220) : ""),
  );
}

/** 顶栏「小计字段」下拉：按 aria-label 认，别看序号——两个视图的 select 数量不一样 */
const pickSubtotalField = (fieldId) =>
  evalJs(`(() => {
    const sel = [...document.querySelectorAll('select')].find(s => s.offsetParent !== null && s.getAttribute('aria-label')?.match(${SUBTOTAL_LABEL}));
    if (!sel) return 'NO_SELECT';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(sel, ${JSON.stringify(fieldId)});
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);

/** 一块汇总的展示文本（菜单触发器就是结果本身，就地算就地显示） */
const aggText = (sel) =>
  evalJs(`(() => {
    const box = document.querySelector(${JSON.stringify(sel)});
    if (!box) return null;
    const btn = box.matches('button') ? box : box.querySelector('button');
    return btn ? btn.textContent.trim() : null;
  })()`);

/** 在打开的菜单里点一项（真鼠标：Radix 的项要 pointerdown/up 落在项上） */
async function clickMenuItem(regexSrc, scope) {
  const pt = await center(
    `[...document.querySelectorAll(${JSON.stringify(MENU_ITEM)})].find(i => ${regexSrc}.test(i.textContent.trim()))`,
  );
  if (!pt) throw new Error("MENU_ITEM_NOT_FOUND: " + regexSrc + " (scope=" + scope + ")");
  await clickAt(pt.x, pt.y, 700);
}

/** 库里这条视图的 extra（新键都按视图持久化在 views.extra） */
const dbExtra = async (viewId) => {
  const v = await inv("view_get", { id: viewId });
  if (!v) throw new Error("VIEW_MISSING_IN_DB: " + viewId);
  return JSON.parse(v.extra || "{}");
};

/** patchViewConfig 有 400ms 防抖，界面已经变了、库里可能还没落：读到这个键出现（给了 want 就读到等于它）为止。
 *  不能只等「键存在」：换函数时键本来就带着旧值，那会立刻返回旧的那份，把回归读成通过。
 *  超时不抛错，返回最后一次读到的值，让下面的断言去说「实读是什么」。 */
async function dbExtraUntil(viewId, key, want, tries = 16) {
  let e = {};
  for (let i = 0; i < tries; i++) {
    e = await dbExtra(viewId);
    const hit = want === undefined ? e[key] !== undefined : e[key] === want;
    if (hit) return e;
    await sleep(400);
  }
  return e;
}

/** 清掉历次运行的沙箱（宿主 + 派生视图；行/字段/单元格由 FK 级联） */
async function purgeScratch() {
  return evalJs(`(async () => {
    const inv = window.__TAURI_INTERNALS__.invoke;
    const gone = [];
    const wss = await inv('workspace_list', {});
    for (const w of wss) {
      const views = await inv('view_list_by_workspace', { workspaceId: w.id });
      for (const v of views) {
        if (v.name !== ${JSON.stringify(SCRATCH)}) continue;
        const derived = await inv('view_list_for_source', { sourceId: v.id });
        for (const d of derived) {
          await inv('view_purge', { id: d.id });
          gone.push('derived:' + d.layout);
        }
        await inv('view_purge', { id: v.id });
        gone.push('host:' + v.id);
      }
    }
    return gone;
  })()`);
}

/** 建沙箱：宿主表格 + 名称/数量/日期 + 四行（甲乙=今天 2/4，丙=另一格 10，丁=另一格留空）+ 日历与列表两个派生视图
 *  丁故意留空：求和/平均只算填了的格子，正好和「计数=4」区分开 */
async function provision() {
  // 页面树只渲染「当前空间」的节点，workspace_list 的第一项未必是它
  const wsId = await evalJs(`(async () => {
    const inv = window.__TAURI_INTERNALS__.invoke;
    const dom = new Set([...document.querySelectorAll('[data-tree-row]')].map(e => e.getAttribute('data-tree-row')));
    for (const w of await inv('workspace_list', {})) {
      const views = await inv('view_list_by_workspace', { workspaceId: w.id });
      if (views.some(v => dom.has(v.id))) return w.id;
    }
    return null;
  })()`);
  if (!wsId) throw new Error("NO_ACTIVE_WORKSPACE");
  const host = await inv("view_create", {
    id: crypto.randomUUID(),
    workspaceId: wsId,
    parentId: null,
    name: SCRATCH,
    layout: "grid",
    extra: null,
  });
  const f = {};
  for (const [key, type, name] of [
    ["name", "text", "名称"],
    ["amount", "number", "数量"],
    ["date", "date", "日期"],
  ]) {
    f[key] = (await inv("field_create", { viewId: host.id, id: crypto.randomUUID(), fieldType: type, name })).id;
  }
  const rows = [];
  for (const [name, amount, date] of [
    ["甲", 2, TODAY],
    ["乙", 4, TODAY],
    ["丙", 10, LATER],
    ["丁", null, LATER],
  ]) {
    const r = await inv("row_create", { viewId: host.id, id: crypto.randomUUID() });
    await inv("cell_set", { rowId: r.id, fieldId: f.name, value: JSON.stringify(name) });
    await inv("cell_set", { rowId: r.id, fieldId: f.date, value: JSON.stringify(date) });
    if (amount !== null) await inv("cell_set", { rowId: r.id, fieldId: f.amount, value: JSON.stringify(amount) });
    rows.push(r.id);
  }
  const derived = { grid: { id: host.id, chip: SCRATCH } };
  for (const [key, layout, chip, extra] of [
    ["calendar", "calendar", CAL_CHIP, { calendarFieldId: f.date }],
    ["list", "list", LIST_CHIP, {}],
  ]) {
    const created = await inv("view_create", {
      id: crypto.randomUUID(),
      workspaceId: wsId,
      parentId: null,
      name: chip,
      layout,
      sourceId: host.id,
    });
    if (Object.keys(extra).length) {
      await inv("view_update_extra", { id: created.id, extra: JSON.stringify(extra) });
    }
    derived[key] = { id: created.id, chip };
  }
  return { wsId, hostId: host.id, fields: f, rows, derived };
}

/** 顶栏右侧那组里「纯行数」的 span（`text-xs text-neutral-400`，只在没配汇总字段时存在） */
const plainCount = () =>
  evalJs(`(() => {
    const bar = [...document.querySelectorAll('div.h-11')].find(d => d.offsetParent !== null);
    const right = bar && bar.querySelector(':scope > div:last-child');
    if (!right) return null;
    const s = [...right.querySelectorAll('span')].find(
      x => x.className.includes('text-neutral-400') && /^[0-9]+$/.test(x.textContent.trim()),
    );
    return s ? s.textContent.trim() : null;
  })()`);

const hasAggBlock = () => evalJs(`document.querySelectorAll('[data-testid^="aggregate-"]').length`);

/** 视图标签栏是 overflow-x-auto：标签一多，靠后的 rect 有宽度却已在视口外，点了等于没点 */
const activeChip = () =>
  evalJs(`(() => {
    const chip = [...document.querySelectorAll('[role="tablist"] > div')].find((d) => d.className.includes('bg-brand-100'));
    return chip?.querySelector('button')?.textContent.trim() ?? null;
  })()`);

async function clickChip(chip) {
  const find = `[...document.querySelectorAll('[role="tablist"] button')].find(b => b.textContent.trim() === ${JSON.stringify(chip)})`;
  await evalJs(
    `(() => { const el = (${find}); el?.scrollIntoView({ inline: 'center', block: 'center' }); return !!el; })()`,
  );
  await sleep(200);
  const pt = await center(find);
  if (!pt) throw new Error("CHIP_NOT_FOUND: " + chip);
  const hit = await evalJs(`(() => {
    const el = document.elementFromPoint(${pt.x}, ${pt.y});
    const chip = (${find});
    if (chip && chip.contains(el)) return 'ok';
    return el ? (el.textContent.trim().slice(0, 24) || el.tagName) : 'nothing';
  })()`);
  if (hit !== "ok") throw new Error(`CHIP_CLICK_INTERCEPTED: 「${chip}」的落点（${pt.x},${pt.y}）打在「${hit}」上`);
  await clickAt(pt.x, pt.y, 900);
  const now = await activeChip();
  if (now !== chip) throw new Error(`VIEW_SWITCH_FAILED: 点了「${chip}」，激活的还是「${now}」`);
}

async function openSandbox(hostId, minChips) {
  const node = await center(`document.querySelector('[data-tree-row="${hostId}"]')`);
  if (!node) throw new Error("SANDBOX_NOT_IN_TREE");
  await clickAt(node.x, node.y, 1200);
  await waitFor(
    async () => (await evalJs("document.querySelectorAll('[role=tablist] button').length")) >= minChips,
    "view chips",
  );
}

const out = { today: TODAY, later: LATER };
let ids = null;

try {
  await waitFor(ready, "APP_NOT_READY");
  out.purgedBefore = await purgeScratch();
  ids = await provision();
  out.sandbox = { hostId: ids.hostId, fields: ids.fields, rows: ids.rows.length };
  reload();
  await sleep(2500);
  await waitFor(ready, "APP_READY_AFTER_PROVISION");
  await openSandbox(ids.hostId, 3);

  // ── 日历 ────────────────────────────────────────────────
  await clickChip(CAL_CHIP);
  await waitFor(async () => (await evalJs("document.querySelectorAll('[data-row-id]').length")) > 0, "calendar cards");
  // 1. 没配小计字段时，日格头一个汇总块都没有（顶栏 select 停在「不做小计」）
  out.calBefore = await evalJs(`document.querySelectorAll('[data-testid^="cal-subtotal-"]').length`);
  assert(out.calBefore === 0, "日历：未选小计字段时日格头不出现汇总块");

  // 2. 选「数量」→ 没选过函数时按计数回落（与看板列头同一口径），先把两块都换成求和
  out.pickCal = await pickSubtotalField(ids.fields.amount);
  await waitFor(
    async () => (await evalJs(`document.querySelectorAll('[data-testid^="cal-subtotal-"]').length`)) > 0,
    "calendar subtotal blocks",
  );
  await sleep(600);
  // 数字格式真机口径：求和/平均走字段自己的数字格式（默认两位小数），计数是整数——所以下面期望值带 .00
  const cntToday = await aggText(`[data-testid="cal-subtotal-${TODAY}"]`);
  const cntLater = await aggText(`[data-testid="cal-subtotal-${LATER}"]`);
  out.calCount = { today: cntToday, later: cntLater };
  assert(cntToday === "2" && cntLater === "2", `日历：只选字段没选函数 → 回落总行数，两格各 2 行（实读「${cntToday}」/「${cntLater}」）`);

  const cellPt = await center(`document.querySelector('[data-testid="cal-subtotal-${TODAY}"] button')`);
  if (!cellPt) throw new Error("CAL_SUBTOTAL_TRIGGER_NOT_FOUND");
  await clickAt(cellPt.x, cellPt.y, 600);
  await clickMenuItem("/求和|Sum/", "calendar→sum");
  const sumToday = await aggText(`[data-testid="cal-subtotal-${TODAY}"]`);
  const sumLater = await aggText(`[data-testid="cal-subtotal-${LATER}"]`);
  out.calSum = { today: sumToday, later: sumLater };
  assert(sumToday === "6.00", `日历：今天的日格求和 = 2+4 = 6（实读「${sumToday}」）`);
  assert(sumLater === "10.00", `日历：${LATER} 的日格求和 = 10+空 = 10（实读「${sumLater}」）`);
  // 空日格不该挂一块「0」出来占地方
  const blank = await evalJs(`(() => {
    const dates = [...document.querySelectorAll('[data-testid^="cal-subtotal-"]')].map(e => e.getAttribute('data-testid').slice('cal-subtotal-'.length));
    return dates.filter(d => d !== ${JSON.stringify(TODAY)} && d !== ${JSON.stringify(LATER)});
  })()`);
  out.calBlankDays = blank;
  assert(blank.length === 0, "日历：当天没有行就不显示小计块（不是显示 0）");

  // 3. 落库：字段与函数都按视图存在 views.extra
  const calExtra = await dbExtraUntil(ids.derived.calendar.id, "calendarSubtotalFieldId", ids.fields.amount);
  out.calExtra = { field: calExtra.calendarSubtotalFieldId, fn: calExtra.calendarSubtotalFn };
  assert(calExtra.calendarSubtotalFieldId === ids.fields.amount, "日历：字段选择写进 views.extra.calendarSubtotalFieldId");

  // 4. 就地换函数（日格那块菜单就是入口）：平均只算填了的格子
  await clickAt(cellPt.x, cellPt.y, 600);
  await clickMenuItem("/平均|Average/", "calendar→average");
  const avgToday = await aggText(`[data-testid="cal-subtotal-${TODAY}"]`);
  const avgLater = await aggText(`[data-testid="cal-subtotal-${LATER}"]`);
  out.calAvg = { today: avgToday, later: avgLater };
  assert(avgToday === "3.00", `日历：换成平均后今天 = (2+4)/2 = 3（实读「${avgToday}」）`);
  assert(avgLater === "10.00", `日历：${LATER} 只有一个填了的格子，平均仍是 10（实读「${avgLater}」）`);
  const calExtra2 = await dbExtraUntil(ids.derived.calendar.id, "calendarSubtotalFn", "average");
  out.calExtraFn = calExtra2.calendarSubtotalFn;
  assert(calExtra2.calendarSubtotalFn === "average", "日历：函数选择写进 views.extra.calendarSubtotalFn");

  // 5. 整页刷新（等同重启应用的首屏读取）后仍是从库里读出来的那份
  reload();
  await sleep(2500);
  await waitFor(ready, "APP_READY_AFTER_CAL_RELOAD");
  await openSandbox(ids.hostId, 3);
  await clickChip(CAL_CHIP);
  await waitFor(async () => (await evalJs(`!!document.querySelector('[data-testid="cal-subtotal-${TODAY}"]')`)), "cal restored");
  await sleep(400);
  out.calAfterReload = {
    text: await aggText(`[data-testid="cal-subtotal-${TODAY}"]`),
    sel: await evalJs(`(() => {
      const sel = [...document.querySelectorAll('select')].find(s => s.offsetParent !== null && s.getAttribute('aria-label')?.match(${SUBTOTAL_LABEL}));
      return sel ? sel.value : null;
    })()`),
  };
  assert(out.calAfterReload.text === "3.00", "日历：刷新后小计仍是平均 3——配置走库，不是内存态");
  assert(out.calAfterReload.sel === ids.fields.amount, "日历：刷新后顶栏 select 恢复成「数量」");

  // 6. 撤掉字段 = 整件事关掉（函数没有单独存在的意义）
  await pickSubtotalField("");
  await sleep(700);
  out.calAfterOff = await evalJs(`document.querySelectorAll('[data-testid^="cal-subtotal-"]').length`);
  out.calExtraOff = (await dbExtra(ids.derived.calendar.id)).calendarSubtotalFieldId;
  assert(out.calAfterOff === 0, "日历：字段改回「不做小计」后日格小计块全部消失");
  assert(out.calExtraOff === "", "日历：撤掉是写空串进 extra（读出来即未配置）");

  // ── 列表 ────────────────────────────────────────────────
  await clickChip(LIST_CHIP);
  await waitFor(async () => (await evalJs("document.querySelectorAll('[data-row-id]').length")) > 0, "list rows");
  // 7. 未配置时顶栏只有行数
  out.listAggBefore = await hasAggBlock();
  out.listCountBefore = await plainCount();
  assert(
    out.listAggBefore === 0 && out.listCountBefore === String(ids.rows.length),
    `列表：未配置时顶栏只有行数 ${ids.rows.length}，没有汇总块`,
  );

  // 8. 选「数量」→ 那块顶替行数位置；没选过函数时按总行数回落，且回落不写库
  out.pickList = await pickSubtotalField(ids.fields.amount);
  await waitFor(async () => (await aggText(`[data-testid="aggregate-${ids.fields.amount}"]`)) !== null, "list aggregate");
  out.listFallback = await aggText(`[data-testid="aggregate-${ids.fields.amount}"]`);
  assert(out.listFallback === "4", `列表：只选字段 → 回落总行数 4（实读「${out.listFallback}」）`);
  out.listBarWithSum = await plainCount();
  assert(out.listBarWithSum === null, "列表：一块地方只放一个数——选了字段之后纯行数就撤了");
  const listExtra = await dbExtraUntil(ids.derived.list.id, "listSubtotalFieldId", ids.fields.amount);
  out.listExtra = { field: listExtra.listSubtotalFieldId, fn: listExtra.listSubtotalFn };
  assert(listExtra.listSubtotalFieldId === ids.fields.amount, "列表：字段选择写进 views.extra.listSubtotalFieldId");
  assert(listExtra.listSubtotalFn === undefined, "列表：回落的函数不落库（extra 里只有字段）");

  // 8b. 换成求和：全筛集 2+4+10+空
  const trig = await center(`document.querySelector('[data-testid="aggregate-${ids.fields.amount}"]')`);
  if (!trig) throw new Error("LIST_AGGREGATE_TRIGGER_NOT_FOUND");
  await clickAt(trig.x, trig.y, 600);
  await clickMenuItem("/求和|Sum/", "list→sum");
  out.listSum = await aggText(`[data-testid="aggregate-${ids.fields.amount}"]`);
  assert(out.listSum === "16.00", `列表：顶栏求和 = 2+4+10+空 = 16（实读「${out.listSum}」）`);
  out.listExtraSum = (await dbExtraUntil(ids.derived.list.id, "listSubtotalFn", "sum")).listSubtotalFn;
  assert(out.listExtraSum === "sum", "列表：换成求和写进 views.extra.listSubtotalFn");

  // 9. 再换回总行数：4
  await clickAt(trig.x, trig.y, 600);
  await clickMenuItem("/总行数|Row count/", "list→count");
  out.listCount = await aggText(`[data-testid="aggregate-${ids.fields.amount}"]`);
  assert(out.listCount === "4", `列表：换成总行数 = 4（实读「${out.listCount}」）`);
  const listExtra2 = await dbExtraUntil(ids.derived.list.id, "listSubtotalFn", "count");
  out.listExtraFn = listExtra2.listSubtotalFn;
  assert(listExtra2.listSubtotalFn === "count", "列表：函数选择写进 views.extra.listSubtotalFn");

  // 10. 刷新后仍是库里那份
  reload();
  await sleep(2500);
  await waitFor(ready, "APP_READY_AFTER_LIST_RELOAD");
  await openSandbox(ids.hostId, 3);
  await clickChip(LIST_CHIP);
  await waitFor(async () => (await aggText(`[data-testid="aggregate-${ids.fields.amount}"]`)) !== null, "list restored");
  await sleep(400);
  out.listAfterReload = await aggText(`[data-testid="aggregate-${ids.fields.amount}"]`);
  assert(out.listAfterReload === "4", "列表：刷新后顶栏汇总仍是总行数 4");

  // 11. 关掉：顶栏退回只显示行数
  await pickSubtotalField("");
  await sleep(700);
  out.listAggAfterOff = await hasAggBlock();
  out.listCountAfterOff = await plainCount();
  assert(out.listAggAfterOff === 0, "列表：字段改回「不做小计」后汇总块消失");
  assert(
    out.listCountAfterOff === String(ids.rows.length),
    `列表：汇总块一走，行数就回来了（同一块地方不空场）`,
  );

  out.allChecksRan = true;
} catch (e) {
  out.fail = String(e && e.message ? e.message : e);
} finally {
  if (ids) {
    // 沙箱页关掉再 purge：不关的话用户的窗口里会留一个指向已删视图的错误面板
    const closeBtn = await center(`document.querySelector('[data-tab-id="${ids.hostId}"] [data-testid="tab-close"]')`);
    if (closeBtn) {
      await clickAt(closeBtn.x, closeBtn.y, 500);
      out.tabClosed = true;
    }
    out.purgedAfter = await purgeScratch();
    const alive = await evalJs(`(async () => {
      const inv = window.__TAURI_INTERNALS__.invoke;
      const gone = [];
      for (const id of ${JSON.stringify(Object.values(ids.derived).map((d) => d.id))}) {
        if (await inv('view_get', { id })) gone.push(id);
      }
      return gone;
    })()`);
    out.sandboxStillAlive = alive;
  }
}

ws.close();
console.log(JSON.stringify(out, null, 1));
process.exit(out.allChecksRan && !(out.sandboxStillAlive ?? []).length ? 0 : 1);
