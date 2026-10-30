// X 批 1「条件格式抽成共用条、七个视图都能配」的真机取证：这条批披露过「没有组件级用例钉住，真机没跑」。
// 观测方式：CDP 派发真实鼠标点击（顶栏按钮 → 弹窗里逐项点/填 → 完成），落库侧直接读 views.extra 的 condFormats，渲染侧认命中行的色调类名。
// 数据口径：只写自建沙箱表「CDP-cond」（名字刻意不含「条件格式」，否则顶栏按钮和页签标题会被同一段文案认错），
// 开跑先清历史残留、收尾 view_purge 硬删（fields/rows/cells 走 FK 级联），可反复运行。
// 语言口径：界面文案按中英双写匹配，视图名用 ASCII（ZCDP-*），免得用户切了语言就误判成回归。
// 前置: WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 npm run tauri dev
// 用法: node scripts/cdp-cond-format-smoke.mjs
const BASE = "http://127.0.0.1:9222";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SCRATCH = "CDP-cond";
const NOTE = "批注";
const NAME = "名称";
const TODAY = new Date().toISOString().slice(0, 10);
/** 丙丁放到三天后：日历一格的行数 >3 才会折叠成 2 行 +「查看全部」（CalendarView.tsx:287），
 *  四行全塞今天会让丙丁根本不在 DOM 里，未命中行的底色参照物就没了。 */
const LATER = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
const HOT = "cdf-hot";
const COLD = "cdf-cold";
/** 顶栏那枚按钮按 title 精确认，别拿文案找：页签/标题上的按钮文本也可能含「条件格式」四个字
 *  （沙箱表一度叫「CDP条件格式」，querySelectorAll('button') + 正则就命中了标题按钮，点了个寂寞） */
const COND_BTN = 'button[title="条件格式"], button[title="Conditional formatting"]';
const DIALOG = '[data-slot="dialog-content"]';
/** 表单翻页器两个按钮的 title（zh / en 都认，FormView.tsx:134/:145） */
const PAGER_PREV = ["上一行", "Previous row"];
const PAGER_NEXT = ["下一行", "Next row"];

/** 与 COND_TONES 同序（database-cond-format.ts:25）；弹窗里那排色点只有 title，只能按这个顺序取第 n 个 */
const TONE_DOT_INDEX = { gray: 0, green: 1, yellow: 2, orange: 3, red: 4, blue: 5, purple: 6 };
/** 命中后的底色类（COND_TONE_CELL 的第一段） */
const TONE_CLASS = {
  gray: "bg-neutral-100",
  green: "bg-green-50",
  yellow: "bg-yellow-50",
  orange: "bg-orange-50",
  red: "bg-red-50",
  blue: "bg-brand-50",
  purple: "bg-purple-50",
};

/**
 * 七个宿主各配一条「批注 等于 HOT → 整行上某色」。
 * mode: anchor = 行锚点自己（或祖先）带色；cell = 表格视图（色铺在 td 上，且额外再配一条单元格档）；form = 一屏只有一行，用翻页器验当前行。
 * 除 grid/list 外每视图一个色：规则按视图落库，串了别人的规则当场就能从「本视图的色没出现」里看出来。
 * grid 与 list 同色不影响判定——同一时刻只渲染一个视图，两者的规则各自由 dbRules + 角标核对。
 */
const VIEWS = [
  { chip: SCRATCH, key: "grid", tone: "green", mode: "cell" },
  { chip: "ZCDP-list", key: "list", tone: "green", mode: "anchor" },
  { chip: "ZCDP-gallery", key: "gallery", tone: "yellow", mode: "anchor" },
  { chip: "ZCDP-board", key: "board", tone: "orange", mode: "anchor" },
  { chip: "ZCDP-calendar", key: "calendar", tone: "blue", mode: "anchor" },
  { chip: "ZCDP-timeline", key: "timeline", tone: "purple", mode: "anchor" },
  { chip: "ZCDP-form", key: "form", mode: "form", tone: "red" },
];

const ws = new WebSocket(
  (await (await fetch(`${BASE}/json`)).json()).find((x) => x.type === "page").webSocketDebuggerUrl,
);
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
    // 把出事的表达式尾巴带上：这类脚本一半的红灯是注入的字符串拼错了，不是产品的问题
    const flat = expr.replace(/\s+/g, " ").slice(0, 260);
    throw new Error(
      "EVAL: " + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails) + " || " + flat,
    );
  }
  return r.result?.value;
};
const assert = (cond, msg) => {
  if (!cond) throw new Error("ASSERT: " + msg);
  console.log("ok - " + msg);
};
const has = (text, ...cands) => !!text && cands.some((c) => text.includes(c));
async function waitFor(fn, desc, tries = 30, gap = 500) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    try {
      if (await fn()) return true;
      last = null;
    } catch (e) {
      // 整页刷新会把执行上下文抽走，下一轮再试；但连着 30 轮都报错就不是「还没好」，是探针自己坏了
      last = e;
    }
    await sleep(gap);
  }
  throw new Error(
    "TIMEOUT: " + desc + (last ? " | 最后一轮报错: " + String(last.message).replace(/\s+/g, " ").slice(0, 220) : ""),
  );
}
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
const insertText = (t) => cdp("Input.insertText", { text: t });
const reload = () =>
  ws.send(JSON.stringify({ id: ++msgId, method: "Runtime.evaluate", params: { expression: "location.reload()" } }));

/** 取元素中心；弹层里的项是 position:fixed，offsetParent 恒为 null，只能看尺寸 */
const center = (findExpr) =>
  evalJs(`(() => {
    const el = (${findExpr});
    if (!el) return null;
    if (!el.getBoundingClientRect().width) el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
const clickText = async (scope, regex, wait = 300) => {
  // scope 是选择器原文，得当成字符串字面量注进去；直接拼进括号里就变成了一串非法表达式
  const pt = await center(
    `[...document.querySelectorAll(${JSON.stringify(scope)} + ' button')].find(b => ${regex}.test(b.textContent.trim()))`,
  );
  if (!pt) throw new Error("BUTTON_NOT_FOUND: " + regex);
  await clickAt(pt.x, pt.y, wait);
};
const ready = () => evalJs("!!window.__TAURI_INTERNALS__ && !!document.querySelector('[data-tree-row]')");

/**
 * 一行的取色锚点：
 * anchor——列表/画廊/看板/日历/时间线的行锚点（[data-row-id]）本身或其祖先带色；
 * cell——表格视图的色铺在 td 上（grid-row.tsx:189 序号 td、:298 各格 td），tr 自己永远没有；
 * form——表单一屏只渲染当前行，锚点用字段行的标签 span[title=字段名]（FormView.tsx:241）。
 */
const anchorSel = (rowId, mode, fieldId = null) =>
  mode === "cell"
    ? fieldId
      ? `td[data-cell-row="${rowId}"][data-cell-field="${fieldId}"]`
      : `td[data-cell-row="${rowId}"]`
    : mode === "form"
      ? `[title="${NOTE}"]`
      : `[data-row-id="${rowId}"]`;

/** 锚点在不在、色调类有没有落到它（或它的祖先）、以及那一格的计算底色 */
const toneState = (rowId, toneCls, mode, fieldId = null) =>
  evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(anchorSel(rowId, mode, fieldId))});
    if (!el) return { found: false, toned: false, bg: null };
    const hit = el.closest('[class~="${toneCls}"]');
    return { found: true, toned: !!hit, bg: getComputedStyle(hit ?? el).backgroundColor };
  })()`);

const toned = async (rowId, toneCls, mode, fieldId = null) => (await toneState(rowId, toneCls, mode, fieldId)).toned;

const ruleCount = () =>
  evalJs(`(() => {
    for (const b of document.querySelectorAll(${JSON.stringify(COND_BTN)})) {
      if (!b.getBoundingClientRect().width) continue;
      const badge = b.querySelector('span');
      return badge ? badge.textContent.trim() : null;
    }
    return null;
  })()`);

const cellsOf = (hostId, fieldId) =>
  evalJs(`(async () => {
    const cells = await window.__TAURI_INTERNALS__.invoke('cells_load', { viewId: ${JSON.stringify(hostId)} });
    const out = {};
    for (const c of cells) if (c.field_id === ${JSON.stringify(fieldId)}) out[c.row_id] = JSON.parse(c.value);
    return out;
  })()`);

/** 库里这条视图的 condFormats（按视图持久化在 views.extra，别的视图读不到它）。
 *  别用 view_list_by_workspace 找：它的 SQL 带 source_id IS NULL（views/crud.rs:47），派生视图根本不在那份列表里。 */
const dbRules = (viewId) =>
  evalJs(`(async () => {
    const v = await window.__TAURI_INTERNALS__.invoke('view_get', { id: ${JSON.stringify(viewId)} });
    if (!v) return null;
    return JSON.stringify(JSON.parse(v.extra || '{}').condFormats ?? []);
  })()`);

/** 整条视图读不到 = 沙箱被谁清了，别让它伪装成「规则是空数组」 */
const dbRulesOf = async (viewId) => {
  const raw = await dbRules(viewId);
  if (raw === null) throw new Error("VIEW_MISSING_IN_DB: " + viewId);
  return JSON.parse(raw);
};

/** 清掉历次运行的沙箱表（宿主 + 它的派生视图；行/字段/单元格由 FK 级联） */
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

/** 建沙箱：宿主表格 + 名称/批注/状态/日期/封面 + 四行（甲乙=HOT，丙=COLD，丁留空）+ 六个派生视图 */
async function provision() {
  // 页面树只渲染「当前空间」的节点，workspace_list 的第一项未必是它；建错空间就点不到入口
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
    ["name", "text", NAME],
    ["note", "text", NOTE],
    ["status", "single_select", "状态"],
    ["date", "date", "日期"],
    ["cover", "attachment", "封面"],
  ]) {
    f[key] = (await inv("field_create", { viewId: host.id, id: crypto.randomUUID(), fieldType: type, name })).id;
  }
  const opts = [
    { id: "opt-aaa", name: "待办", color: "blue" },
    { id: "opt-bbb", name: "进行中", color: "green" },
  ];
  await inv("field_update_options", { fieldId: f.status, options: JSON.stringify({ kind: "select", options: opts }) });

  const rows = [];
  for (const [name, note, status, date] of [
    ["甲", HOT, "opt-aaa", TODAY],
    ["乙", HOT, "opt-aaa", TODAY],
    ["丙", COLD, "opt-bbb", LATER],
    ["丁", null, "opt-bbb", LATER],
  ]) {
    const r = await inv("row_create", { viewId: host.id, id: crypto.randomUUID() });
    await inv("cell_set", { rowId: r.id, fieldId: f.name, value: JSON.stringify(name) });
    await inv("cell_set", { rowId: r.id, fieldId: f.status, value: JSON.stringify(status) });
    await inv("cell_set", { rowId: r.id, fieldId: f.date, value: JSON.stringify(date) });
    if (note) await inv("cell_set", { rowId: r.id, fieldId: f.note, value: JSON.stringify(note) });
    rows.push(r.id);
  }

  const derived = { grid: { id: host.id, chip: SCRATCH } };
  for (const v of VIEWS) {
    if (v.key === "grid") continue;
    const created = await inv("view_create", {
      id: crypto.randomUUID(),
      workspaceId: wsId,
      parentId: null,
      name: v.chip,
      layout: v.key,
      sourceId: host.id,
    });
    const extra =
      v.key === "board"
        ? { boardFieldId: f.status }
        : v.key === "calendar"
          ? { calendarFieldId: f.date }
          : v.key === "gallery"
            ? { galleryFieldId: f.cover }
            : v.key === "timeline"
              ? { timelineStartFieldId: f.date }
              : {};
    await inv("view_update_extra", { id: created.id, extra: JSON.stringify(extra) });
    derived[v.key] = { id: created.id, chip: v.chip };
  }
  return { wsId, hostId: host.id, fields: f, rows, derived };
}

/** 视图标签栏是 overflow-x-auto：标签一多，第 4 个起 rect 有宽度却已在视口外，点了等于没点 */
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

/** 顶栏「条件格式」→ 弹窗（真鼠标点）；多个同名按钮时取第一个真有尺寸的（隐藏页签里的那个点了不算） */
async function openDialog() {
  const pt = await evalJs(`(() => {
    for (const b of document.querySelectorAll(${JSON.stringify(COND_BTN)})) {
      const r = b.getBoundingClientRect();
      if (r.width && r.height) return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    }
    return null;
  })()`);
  if (!pt) throw new Error("COND_BUTTON_NOT_FOUND（没有可见顶栏？同名按钮全在隐藏页签里？）");
  // 与标签栏同款口径：有 rect ≠ 点得到，先拿落点做一次命中测试
  const hit = await evalJs(`(() => {
    const el = document.elementFromPoint(${pt.x}, ${pt.y});
    if (!el) return 'nothing';
    return el.closest(${JSON.stringify(COND_BTN)}) ? 'ok' : el.textContent.trim().slice(0, 24) || el.tagName;
  })()`);
  if (hit !== "ok") throw new Error(`COND_CLICK_INTERCEPTED: 「条件格式」的落点（${pt.x},${pt.y}）打在「${hit}」上`);
  await clickAt(pt.x, pt.y, 400);
  await waitFor(() => evalJs(`!!document.querySelector('${DIALOG}')`), "cond dialog opens");
}

/** 点「新增规则」并把它填成「<字段> <op> <值> → 某色 / 某档」；弹窗里控件同样没有 testid */
async function fillRule({ fieldId, op, value, tone, scope }) {
  const selCount = () => evalJs(`document.querySelectorAll('${DIALOG} select').length`);
  // 一条规则两个 <select>（字段 + 比较符），按「比点之前多 2」等它渲染：
  // 只看「≥2」会在已有规则的行上就地空转，把上一条改掉
  const before = await selCount();
  await clickText(DIALOG, "/新增规则|Add rule/", 250);
  await waitFor(async () => (await selCount()) >= before + 2, "the new rule row renders");
  // 弹窗里已有规则排在前面，新那条一定在最尾 → 全部按「最后一个」定位
  // 两个受控 <select>：直接赋值会被 React 盖回去，走原型 setter + 冒泡 change
  const setSelect = async (offsetFromEnd, val) =>
    evalJs(`(() => {
      const sels = [...document.querySelectorAll('${DIALOG} select')];
      const sel = sels[sels.length - ${offsetFromEnd}];
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, ${JSON.stringify(val)});
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return sel.options[sel.selectedIndex]?.text ?? null;
    })()`);
  const fieldName = await setSelect(2, fieldId);
  await sleep(200);
  // 上一条规则可能已经带着一只操作数框，「最后一个 input」在新一条挂载前指的就是它 → 按增量等
  const inCount = () => evalJs(`document.querySelectorAll('${DIALOG} input').length`);
  const insBefore = await inCount();
  const opName = await setSelect(1, op);
  await sleep(200);
  // 换字段会把比较符重置成该类型的第一档（文本是「为空」），所以必须等 op 落定再填操作数
  // 「为空」这类比较符根本不冒操作数框，超时信息里带上比较符名，一眼分得清是脚本还是产品的问题
  await waitFor(
    async () =>
      evalJs(`(() => {
        const inputs = [...document.querySelectorAll('${DIALOG} input')];
        if (inputs.length < ${insBefore} + 1) return false;
        const el = inputs[inputs.length - 1];
        el.focus();
        return true;
      })()`),
    `操作数输入框挂载（比较符「${opName}」）`,
  );
  await insertText(value);
  await sleep(200);
  const typed = await evalJs(`(() => {
    const inputs = [...document.querySelectorAll('${DIALOG} input')];
    return inputs[inputs.length - 1]?.value ?? null;
  })()`);
  assert(typed === value, `弹窗里操作数填成「${typed}」（字段「${fieldName}」、比较符「${opName}」）`);
  // 色点只有 title=颜色，按 COND_TONES 顺序在「最后一组七枚」里取第 n 枚
  const dotPt = await center(
    `(() => { const d = [...document.querySelectorAll('${DIALOG} button')].filter(b => /颜色|Colour/.test(b.title ?? '')); return d[d.length - 7 + ${TONE_DOT_INDEX[tone]}]; })()`,
  );
  if (!dotPt) throw new Error("TONE_DOT_NOT_FOUND: " + tone);
  await clickAt(dotPt.x, dotPt.y, 250);
  // 新规则默认是单元格档（newCondRule），整行档得点一下切换
  if (scope === "row") {
    const scopePt = await center(
      `[...document.querySelectorAll('${DIALOG} button')].filter(b => /^整行$|^Whole row$/.test(b.textContent.trim())).slice(-1)[0]`,
    );
    if (!scopePt) throw new Error("SCOPE_ROW_BUTTON_NOT_FOUND");
    await clickAt(scopePt.x, scopePt.y, 250);
  }
  return { fieldName, opName };
}

/** 逐视图配一条规则并核对渲染 + 落库 */
async function configureAndCheck(v, ids) {
  const cls = TONE_CLASS[v.tone];
  await openDialog();
  await fillRule({ fieldId: ids.fields.note, op: "equals", value: HOT, tone: v.tone, scope: "row" });
  await clickText(DIALOG, "/完成|Done/", 500);
  await waitFor(async () => !(await evalJs(`!!document.querySelector('${DIALOG}')`)), "dialog closes after 完成");
  // patchViewConfig 有 400ms 防抖，落库晚于点「完成」
  await sleep(700);

  const rules = await dbRulesOf(ids.derived[v.key].id);
  const row = rules.find((r) => r.field_id === ids.fields.note);
  assert(
    !!row && row.op === "equals" && row.value === HOT && row.tone === v.tone && row.scope === "row",
    `${v.chip}：views.extra 里落了「批注 等于 HOT → ${v.tone} / ${row?.scope}」（本视图共 ${rules.length} 条）`,
  );
  assert((await ruleCount()) === String(rules.length), `${v.chip}：顶栏按钮角标是 ${rules.length}（规则数按视图算）`);
  // 表单一屏只渲染当前行，[title=批注] 这个锚点跟的是「现在这行」而不是某个 rowId，逐行断言只能交给 formTier
  if (v.mode !== "form") {
    await assertToneSet(v, ids, cls);
    await assertRenderedColor(v, ids);
  }
}

/** 该视图里「带某色的行」必须正好是甲乙两行；丙（另一值）和丁（空值）不许沾色 */
async function assertToneSet(v, ids, cls) {
  const got = [];
  for (const [i, rowId] of ids.rows.entries()) {
    const s = await toneState(rowId, cls, v.mode, v.mode === "cell" ? ids.fields.note : null);
    got.push({ name: ["甲", "乙", "丙", "丁"][i], toned: s.toned, found: s.found });
  }
  const expect = ids.rows.map((_, i) => i < 2);
  const actual = got.map((g) => g.toned);
  assert(
    JSON.stringify(actual) === JSON.stringify(expect),
    `${v.chip}：${cls} 只落在甲乙两行（实拿 ${JSON.stringify(got)}）`,
  );
  assert(
    got.every((g) => g.found),
    `${v.chip}：四行在这个宿主里都找得到取色锚点（缺行 = 锚点选错了，不是没上色）`,
  );
  return got;
}

/** 类名铺上 ≠ 肉眼见色：同一格上还挂着 bg-white / bg-neutral-100 时，谁赢是样式表顺序定的，不随 className 里的先后。
 *  所以拿「甲的底色」和「丙的底色」直接比，相等就说明色根本没渲染出来。 */
async function assertRenderedColor(v, ids, label = "整行档") {
  const note = v.mode === "cell" ? ids.fields.note : null;
  const hot = await toneState(ids.rows[0], TONE_CLASS[v.tone], v.mode, note);
  const cold = await toneState(ids.rows[2], TONE_CLASS[v.tone], v.mode, note);
  assert(
    hot.bg !== cold.bg && hot.toned && !cold.toned,
    `${v.chip}：${label}的底色真的分得开（甲 ${hot.bg} / 丙 ${cold.bg}）`,
  );
}

/** 表格视图额外的第二档：名称 等于 丙 → 单元格紫，且这一行的别的格子不许跟着紫 */
async function gridCellTier(ids) {
  await openDialog();
  await fillRule({ fieldId: ids.fields.name, op: "equals", value: "丙", tone: "purple", scope: "cell" });
  await clickText(DIALOG, "/完成|Done/", 500);
  await waitFor(async () => !(await evalJs(`!!document.querySelector('${DIALOG}')`)), "dialog closes (cell tier)");
  await sleep(700);
  const rules = await dbRulesOf(ids.derived.grid.id);
  const cell = rules.find((r) => r.scope === "cell");
  assert(
    !!cell && cell.field_id === ids.fields.name && cell.value === "丙" && cell.tone === "purple",
    `宿主表格：第二条规则落了「名称 等于 丙 → purple / 单元格档」（本视图共 ${rules.length} 条）`,
  );
  assert((await ruleCount()) === String(rules.length), `宿主表格：角标跟到 ${rules.length}`);
  const purpleNameCell = await toned(ids.rows[2], "bg-purple-50", "cell", ids.fields.name);
  const purpleNoteCell = await toned(ids.rows[2], "bg-purple-50", "cell", ids.fields.note);
  assert(
    purpleNameCell && !purpleNoteCell,
    `单元格档只铺在「名称」那一格（丙的名称=${purpleNameCell}、批注=${purpleNoteCell}）`,
  );
  const greenOnBing = await toned(ids.rows[2], TONE_CLASS.green, "cell");
  assert(!greenOnBing, `丙没吃整行档（它的批注是 ${COLD}，不等于 ${HOT}）`);
  await gridFrozenCells(ids);
}

/** 冻结的两格（序号 td、主字段 td）自带 bg-white（grid-row.tsx:189/:295），色调类与它同为单类选择器，
 *  谁赢取决于样式表顺序，跟 className 里的先后无关。所以这里不看类名，直接比计算底色：
 *  命中行和「两档都没命中的丁」算出同一个白，就说明色铺在 DOM 上却没落到肉眼。 */
async function gridFrozenCells(ids) {
  const refIdx = (await toneState(ids.rows[3], TONE_CLASS.green, "cell")).bg;
  const refMain = (await toneState(ids.rows[3], TONE_CLASS.green, "cell", ids.fields.name)).bg;
  const hotIdx = await toneState(ids.rows[0], TONE_CLASS.green, "cell");
  const hotMain = await toneState(ids.rows[0], TONE_CLASS.green, "cell", ids.fields.name);
  const coldMain = await toneState(ids.rows[2], "bg-purple-50", "cell", ids.fields.name);
  assert(
    hotIdx.toned && hotIdx.bg !== refIdx,
    `冻结序号格：整行档的绿盖掉了它自己的 bg-white（甲 ${hotIdx.bg}，未命中的丁 ${refIdx}）`,
  );
  assert(
    hotMain.toned && hotMain.bg !== refMain,
    `冻结主字段格：整行档的绿同样可见（甲 ${hotMain.bg}，丁 ${refMain}）`,
  );
  assert(coldMain.toned && coldMain.bg !== refMain, `冻结主字段格：单元格档的紫也可见（丙 ${coldMain.bg}）`);
}

/** 删规则：日历那条删掉之后本视图掉色，别的视图不受影响——这才叫按视图持久化 */
async function deleteRuleAndCheck(v, ids) {
  await openDialog();
  const pt = await center(
    `[...document.querySelectorAll('${DIALOG} button')].find(b => /删除规则|Delete rule/.test(b.title ?? ''))`,
  );
  if (!pt) throw new Error("DELETE_BUTTON_NOT_FOUND");
  await clickAt(pt.x, pt.y, 400);
  await clickText(DIALOG, "/完成|Done/", 500);
  await waitFor(async () => !(await evalJs(`!!document.querySelector('${DIALOG}')`)), "dialog closes after delete");
  await sleep(700);
  const rules = await dbRulesOf(ids.derived[v.key].id);
  assert(rules.length === 0, `${v.chip}：删完库里 condFormats 是空数组（实拿 ${rules.length} 条）`);
  const tonedRows = [];
  for (const rowId of ids.rows) if (await toned(rowId, TONE_CLASS[v.tone], v.mode, null)) tonedRows.push(rowId);
  assert(
    tonedRows.length === 0,
    `${v.chip}：删完本视图不再上色（还带 ${TONE_CLASS[v.tone]} 的行 ${JSON.stringify(tonedRows)}）`,
  );
  assert((await ruleCount()) === null, `${v.chip}：按钮角标跟着没了`);

  await clickChip(VIEWS[1].chip);
  await waitFor(() => toned(ids.rows[0], TONE_CLASS[VIEWS[1].tone], "anchor"), "the other view keeps its tone");
  assert(
    await toned(ids.rows[0], TONE_CLASS[VIEWS[1].tone], "anchor"),
    `换到 ${VIEWS[1].chip}：它自己的色还在（删规则没有跨视图串改）`,
  );
}

/** 翻页器那一段文本（「1 / 4」），FormView.tsx:138-140 夹在上一行/下一行两个按钮中间 */
const pagerText = () =>
  evalJs(
    `document.querySelector('[title="${PAGER_NEXT[0]}"], [title="${PAGER_NEXT[1]}"]')?.parentElement?.textContent.trim() ?? null`,
  );

/** 表单一屏只渲染当前行：整行档得跟着翻页器走，翻到不命中的行要掉色、翻回来要复原 */
async function formTier(ids) {
  const total = ids.rows.length;
  const first = await toneState(ids.rows[0], TONE_CLASS.red, "form");
  const p0 = await pagerText();
  assert(
    p0 === `1 / ${total}` && first.found && first.toned,
    `表单停在第 1 行（翻页器「${p0}」），当前行（甲）的字段行铺上 ${TONE_CLASS.red}（底色 ${first.bg}）`,
  );
  const next = await center(`document.querySelector('[title="${PAGER_NEXT[0]}"], [title="${PAGER_NEXT[1]}"]')`);
  if (!next) throw new Error("FORM_NEXT_ROW_BUTTON_NOT_FOUND");
  await clickAt(next.x, next.y, 350);
  await clickAt(next.x, next.y, 350);
  const p2 = await pagerText();
  const third = await toneState(ids.rows[2], TONE_CLASS.red, "form");
  assert(
    p2 === `3 / ${total}` && !third.toned,
    `翻到第 3 行（丙，批注是 ${COLD}）：翻页器「${p2}」、字段行不沾 ${TONE_CLASS.red}（底色 ${third.bg}）`,
  );
  assert(first.bg !== third.bg, `底色跟着当前行走（甲 ${first.bg} → 丙 ${third.bg}）`);
  const prev = await center(`document.querySelector('[title="${PAGER_PREV[0]}"], [title="${PAGER_PREV[1]}"]')`);
  if (!prev) throw new Error("FORM_PREV_ROW_BUTTON_NOT_FOUND");
  await clickAt(prev.x, prev.y, 350);
  await clickAt(prev.x, prev.y, 350);
  const back = await toneState(ids.rows[0], TONE_CLASS.red, "form");
  assert(
    (await pagerText()) === `1 / ${total}` && back.toned && back.bg === first.bg,
    `翻回第 1 行色又回来（${back.bg}）——不是翻一次就丢的残留`,
  );
}

const out = { views: [], sandbox: null, fail: null };
let ids = null;

try {
  await waitFor(ready, "APP_NOT_READY");
  out.purgedBefore = await purgeScratch();
  ids = await provision();
  out.sandbox = { hostId: ids.hostId, fields: ids.fields, rows: ids.rows };

  reload();
  await sleep(2500);
  await waitFor(ready, "APP_READY_AFTER_PROVISION");
  const node = await center(`document.querySelector('[data-tree-row="${ids.hostId}"]')`);
  if (!node) throw new Error("SANDBOX_NOT_IN_TREE");
  await clickAt(node.x, node.y, 1200);
  await waitFor(
    async () => (await evalJs("document.querySelectorAll('[role=tablist] button').length")) >= 6,
    "view chips",
  );

  for (const v of VIEWS) {
    await clickChip(v.chip);
    await configureAndCheck(v, ids);
    if (v.mode === "form") await formTier(ids);
    if (v.key === "grid") await gridCellTier(ids);
    if (v.key === "calendar") await deleteRuleAndCheck(v, ids);
    out.views.push({ chip: v.chip, tone: v.tone });
  }

  // 刷新后颜色还在 = 规则是从库里读出来的，不是内存里凑巧留着
  reload();
  await sleep(2500);
  await waitFor(ready, "APP_READY_AFTER_RELOAD");
  const node2 = await center(`document.querySelector('[data-tree-row="${ids.hostId}"]')`);
  if (!node2) throw new Error("SANDBOX_NOT_IN_TREE_AFTER_RELOAD");
  await clickAt(node2.x, node2.y, 1500);
  // 刷新后落在上次停留的视图（activeViewId 也是按视图存的），得先把标签栏等回来再显式点回宿主表格
  await waitFor(
    async () => (await evalJs("document.querySelectorAll('[role=tablist] button').length")) >= 6,
    "view chips back after reload",
  );
  await clickChip(VIEWS[0].chip);
  await waitFor(
    async () => (await evalJs("document.querySelectorAll('td[data-cell-row]').length")) > 0,
    "grid rows back",
  );
  await assertToneSet(VIEWS[0], ids, TONE_CLASS[VIEWS[0].tone]);
  await clickChip(VIEWS[2].chip);
  await waitFor(() => toned(ids.rows[0], TONE_CLASS[VIEWS[2].tone], "anchor"), "gallery tone after reload");
  assert(
    await toned(ids.rows[0], TONE_CLASS[VIEWS[2].tone], "anchor"),
    `${VIEWS[2].chip}：整页刷新后仍然上色——规则走 views.extra，不是内存态`,
  );
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
    // 按名字扫只能扫到宿主（view_list_by_workspace 带 source_id IS NULL），派生视图得逐个 id 问 view_get
    const alive = await evalJs(`(async () => {
      const inv = window.__TAURI_INTERNALS__.invoke;
      const gone = [];
      for (const id of ${JSON.stringify(Object.values(ids.derived).map((d) => d.id))}) {
        if (await inv('view_get', { id })) gone.push(id);
      }
      return gone;
    })()`);
    out.aliveAfterPurge = alive;
    const leftovers = await evalJs(`(async () => {
      const inv = window.__TAURI_INTERNALS__.invoke;
      const wss = await inv('workspace_list', {});
      const hit = [];
      for (const w of wss) {
        const views = await inv('view_list_by_workspace', { workspaceId: w.id });
        for (const v of views) if (v.name === ${JSON.stringify(SCRATCH)} || v.name?.startsWith('ZCDP-')) hit.push(v.name);
      }
      return hit.join(',') || 'none';
    })()`);
    out.leftover = leftovers;
    // 这里不 assert：finally 里抛错会把下面的 JSON 吞掉，红灯时反而看不到现场
    reload();
  }
}

console.log("\n" + JSON.stringify(out, null, 2));
console.log("\nEXCEPTIONS(" + exceptions.length + "):");
for (const e of exceptions.slice(0, 8)) console.log("---\n" + e);
if (out.leftover !== undefined) assert(out.leftover === "none", `沙箱表已清干净：${out.leftover}`);
if (out.aliveAfterPurge !== undefined)
  assert(
    out.aliveAfterPurge.length === 0,
    `七个沙箱视图的 id 全部 view_get 不到（还活着：${JSON.stringify(out.aliveAfterPurge)}）`,
  );
if (out.fail || exceptions.length > 0) process.exitCode = 1;
else console.log("\nCOND_FORMAT_SMOKE_PASS views=" + out.views.length);
// 不关掉 socket，node 会带着事件循环一直挂着（上一轮就是这么被挪到后台的）
ws.close();
