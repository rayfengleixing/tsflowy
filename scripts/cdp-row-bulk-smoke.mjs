// X 批 2b/2c 那条「零用例、真机没验」的右键链收口：五个视图各跑一遍「右键 → 选择该行 → 批量修改 → 落库」。
// 观测方式：CDP 派发真实鼠标右键（不是往 DOM 上打合成 contextmenu），全程收集 Runtime.exceptionThrown，断言失败退出非 0。
// 数据口径：只写自建沙箱表「CDP批量冒烟」，开跑先清历史残留、收尾 view_purge 硬删（fields/rows/cells 走 FK 级联），可反复运行。
// 语言口径：界面文案按中英双写匹配，视图名用 ASCII（CDP-list 等），免得用户切了语言就误判成回归。
// 前置: WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 npm run tauri dev
// 用法: node scripts/cdp-row-bulk-smoke.mjs
const BASE = "http://127.0.0.1:9222";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SCRATCH = "CDP批量冒烟";
const NOTE = "批注";
const TODAY = new Date().toISOString().slice(0, 10);

/** 每个派生视图跑完整链；value 逐视图不同，免得「设为同值」被 buildBulkUpdates 跳过 */
const VIEWS = [
  { chip: "CDP-list", key: "list", value: "v-list" },
  { chip: "CDP-gallery", key: "gallery", value: "v-gallery" },
  { chip: "CDP-board", key: "board", value: "v-board" },
  { chip: "CDP-calendar", key: "calendar", value: "v-calendar" },
  { chip: "CDP-timeline", key: "timeline", value: "v-timeline" },
];

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
  if (r.exceptionDetails)
    throw new Error("EVAL: " + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails));
  return r.result?.value;
};
const assert = (cond, msg) => {
  if (!cond) throw new Error("ASSERT: " + msg);
  console.log("ok - " + msg);
};
const has = (text, ...cands) => !!text && cands.some((c) => text.includes(c));
async function waitFor(fn, desc, tries = 30, gap = 500) {
  for (let i = 0; i < tries; i++) {
    try {
      if (await fn()) return true;
    } catch {
      /* 整页刷新会把执行上下文抽走，下一轮再试 */
    }
    await sleep(gap);
  }
  throw new Error("TIMEOUT: " + desc);
}
const inv = (cmd, args) =>
  evalJs(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? {})})`);
const mouse = (type, x, y, extra = {}) =>
  cdp("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, ...extra });
const rightMouse = (type, x, y) => cdp("Input.dispatchMouseEvent", { type, x, y, button: "right", clickCount: 1 });
const clickAt = async (x, y, wait = 350) => {
  await mouse("mouseMoved", x, y);
  await sleep(80);
  await mouse("mousePressed", x, y);
  await mouse("mouseReleased", x, y);
  await sleep(wait);
};
/** 右键一次完整的按下再松开：Chromium 的 contextmenu 落在这条真实序列里，正是本批要验的东西 */
const rightClickAt = async (x, y) => {
  await rightMouse("mouseMoved", x, y);
  await sleep(80);
  await rightMouse("mousePressed", x, y);
  await sleep(250);
  await rightMouse("mouseReleased", x, y);
  await sleep(200);
};
const pressKey = (key, vk) =>
  cdp("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode: vk }).then(() =>
    cdp("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: vk }),
  );
const escape = () => pressKey("Escape", 27);
const insertText = (t) => cdp("Input.insertText", { text: t });
// location.reload() 会先销毁执行上下文再回包，await 会永远挂起 → 只发不等
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

// 页面树的锚点是 data-tree-row（老脚本里的 data-view-id 已经在侧栏重构中没了）
const ready = () => evalJs("!!window.__TAURI_INTERNALS__ && !!document.querySelector('[data-tree-row]')");
const MENU = '[data-slot="context-menu-content"]';
const DIALOG = '[data-slot="dialog-content"]';

/**
 * 选中圈挂在 RowSelectMenu 的根上，而时间线的 data-row-id 在内层条上 → 从行锚点往上找。
 * 必须连 z-10 一起认：日历的「今天」日格（CalendarView.tsx:295）和拖拽中的卡片（:462）都带 ring-brand-500，
 * 只认那个类名会把「没清掉选中圈」判成永远成立。
 */
const isRinged = (rowId) =>
  evalJs(`(() => {
    const el = document.querySelector('[data-row-id="${rowId}"]');
    return !!el && !!el.closest('[class~="z-10"][class~="ring-brand-500"]');
  })()`);
const rowIdsInDom = () =>
  evalJs(`[...new Set([...document.querySelectorAll('[data-row-id]')].map(e => e.getAttribute('data-row-id')))]`);
const hasRows = (n) => async () => (await rowIdsInDom()).length >= n;

/** 右键菜单里那一项此刻的状态（菜单没开返回 null） */
const ctxItem = (testid) =>
  evalJs(`(() => {
    const el = document.querySelector('${MENU} [data-testid="${testid}"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { text: el.textContent.trim(), w: Math.round(r.width), badge: el.querySelector('span')?.textContent.trim() ?? null };
  })()`);

const cellsOf = (hostId, fieldId) =>
  evalJs(`(async () => {
    const cells = await window.__TAURI_INTERNALS__.invoke('cells_load', { viewId: ${JSON.stringify(hostId)} });
    const out = {};
    for (const c of cells) if (c.field_id === ${JSON.stringify(fieldId)}) out[c.row_id] = JSON.parse(c.value);
    return out;
  })()`);

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

/** 建沙箱：宿主表格 + 名称/批注/状态/日期/封面 五个字段 + 四行 + 五个派生视图（分组字段直接写进 extra） */
async function provision() {
  // 页面树只渲染「当前空间」的节点，workspace_list 的第一项未必是它；建错空间就点不到入口
  const wsId = await evalJs(`(async () => {
    const inv = window.__TAURI_INTERNALS__.invoke;
    const wss = await inv('workspace_list', {});
    const dom = new Set([...document.querySelectorAll('[data-tree-row]')].map(e => e.getAttribute('data-tree-row')));
    for (const w of wss) {
      const views = await inv('view_list_by_workspace', { workspaceId: w.id });
      if (views.some(v => dom.has(v.id))) return w.id;
    }
    return wss[0]?.id ?? null;
  })()`);
  if (!wsId) throw new Error("NO_WORKSPACE");
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
  for (const [name, status] of [
    ["甲", "opt-aaa"],
    ["乙", "opt-aaa"],
    ["丙", "opt-bbb"],
    ["丁", "opt-bbb"],
  ]) {
    const r = await inv("row_create", { viewId: host.id, id: crypto.randomUUID() });
    await inv("cell_set", { rowId: r.id, fieldId: f.name, value: JSON.stringify(name) });
    await inv("cell_set", { rowId: r.id, fieldId: f.status, value: JSON.stringify(status) });
    await inv("cell_set", { rowId: r.id, fieldId: f.date, value: JSON.stringify(TODAY) });
    rows.push(r.id);
  }

  const derived = {};
  for (const { chip, key, value } of VIEWS) {
    const v = await inv("view_create", {
      id: crypto.randomUUID(),
      workspaceId: wsId,
      parentId: null,
      name: chip,
      layout: key,
      sourceId: host.id,
    });
    const extra =
      key === "board"
        ? { boardFieldId: f.status }
        : key === "calendar"
          ? { calendarFieldId: f.date }
          : key === "gallery"
            ? { galleryFieldId: f.cover }
            : key === "timeline"
              ? { timelineStartFieldId: f.date }
              : {};
    await inv("view_update_extra", { id: v.id, extra: JSON.stringify(extra) });
    derived[key] = { id: v.id, chip, value };
  }
  return { hostId: host.id, fields: f, rows, derived };
}

/** 当前激活的视图标签文本（ViewChips 用 bg-brand-100 标激活，没有 aria-selected 可读） */
const activeChip = () =>
  evalJs(`(() => {
    const chip = [...document.querySelectorAll('[role="tablist"] > div')].find((d) => d.className.includes('bg-brand-100'));
    return chip?.querySelector('button')?.textContent.trim() ?? null;
  })()`);

async function clickChip(chip) {
  // 标签栏是 overflow-x-auto：视图一多，右边的标签会被横向裁掉，rect 有宽度但落在视口外，点下去谁也不挨着
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

/** 一个视图的完整链：右键开菜单 → 勾两行 → 批量修改 → 把「批注」设为该视图专属值 → 读库核对只改到勾选行 */
async function smokeView(chip, value, ids) {
  // 探针：进视图时给还活着的弹窗打标记，后面操作到的那个节点若带旧标记，说明它是上一个视图的遗留实例
  await evalJs(
    `[...document.querySelectorAll('${DIALOG}')].forEach(d => { d.dataset.probe = ${JSON.stringify(chip)}; });`,
  );
  const dialogCountAtEntry = await evalJs(`document.querySelectorAll('${DIALOG}').length`);
  assert(dialogCountAtEntry === 0, `${chip}：进视图时没有别的弹窗活着，实拿 ${dialogCountAtEntry} 个`);
  const domIds = await rowIdsInDom();
  if (domIds.length < 2) throw new Error("NOT_ENOUGH_ROWS in " + chip + ": " + JSON.stringify(domIds));
  const [a, b] = domIds;

  const ptA = await center(`document.querySelector('[data-row-id="${a}"]')`);
  if (!ptA) throw new Error("ROW_NOT_VISIBLE: " + chip + "/" + a);
  await rightClickAt(ptA.x, ptA.y);
  await waitFor(() => ctxItem(`row-ctx-toggle-${a}`), "context menu opens on a real right-click");
  const first = await ctxItem(`row-ctx-toggle-${a}`);
  assert(has(first.text, "选择该行", "Select row"), `${chip}：真实鼠标右键打开菜单，首项是「${first.text}」`);

  const toggleA = await center(`document.querySelector('${MENU} [data-testid="row-ctx-toggle-${a}"]')`);
  await clickAt(toggleA.x, toggleA.y, 300);
  assert(await waitFor(() => isRinged(a), "ring on " + a), `${chip}：点「选择该行」后该行挂上选中圈`);

  const ptB = await center(`document.querySelector('[data-row-id="${b}"]')`);
  await rightClickAt(ptB.x, ptB.y);
  await waitFor(() => ctxItem(`row-ctx-toggle-${b}`), "menu for row b");
  const toggleB = await center(`document.querySelector('${MENU} [data-testid="row-ctx-toggle-${b}"]')`);
  await clickAt(toggleB.x, toggleB.y, 300);
  assert((await isRinged(a)) && (await isRinged(b)), `${chip}：第二行也选中，两行同时带圈`);

  await rightClickAt(ptA.x, ptA.y);
  await waitFor(() => ctxItem("row-ctx-bulk-edit"), "bulk edit item shows");
  const again = await ctxItem(`row-ctx-toggle-${a}`);
  assert(has(again.text, "取消选择", "Deselect"), `${chip}：已选中的行再右键，首项变「${again.text}」（切换对称）`);
  const bulk = await ctxItem("row-ctx-bulk-edit");
  assert(has(bulk.text, "批量修改", "Bulk edit") && bulk.badge === "2", `${chip}：「批量修改」角标是 ${bulk.badge}`);
  const bulkPt = await center(`document.querySelector('${MENU} [data-testid="row-ctx-bulk-edit"]')`);
  await clickAt(bulkPt.x, bulkPt.y, 400);

  await waitFor(() => evalJs(`!!document.querySelector('[data-slot="dialog-title"]')`), "bulk dialog opens");
  // waitFor 只回真假，标题要单独取（弹窗偶尔先渲染容器再填字，多等一轮即可）
  const title = await evalJs(`document.querySelector('[data-slot="dialog-title"]')?.textContent.trim() ?? null`);
  assert(has(title, "批量修改 2 行", "Bulk edit 2 rows"), `${chip}：弹窗标题「${title}」`);

  // 字段选择器是 React 受控 <select>：直接赋值会被 React 盖回去，要走原型 setter + 冒泡 change
  const pickedField = await evalJs(`(() => {
    const sel = document.querySelector('${DIALOG} select');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, ${JSON.stringify(ids.fields.note)});
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return sel.options[sel.selectedIndex]?.text ?? null;
  })()`);
  await sleep(250);
  assert(pickedField === NOTE, `${chip}：字段选到「${pickedField}」`);
  const opPt = await center(
    `[...document.querySelectorAll('${DIALOG} button')].find(b => /设为|Set to/.test(b.textContent.trim()))`,
  );
  await clickAt(opPt.x, opPt.y, 200);
  const preType = await evalJs(`document.querySelector('${DIALOG} input')?.value ?? null`);
  // 先读上一个视图留的戳，再打自己的：戳还在就说明这个弹窗节点跨视图活下来了
  const inherited = await evalJs(`document.querySelector('${DIALOG}')?.dataset.marker ?? null`);
  await evalJs(`document.querySelector('${DIALOG}').dataset.marker = ${JSON.stringify(chip)};`);
  // 落点点击容易被上一视图残留的 toast 截走（看板那次就是这么空的），所以走 focus() 拿焦点再 insertText
  await evalJs(`(() => {
    const el = document.querySelector('${DIALOG} input');
    el.focus();
    return true;
  })()`);
  await sleep(120);
  await insertText(value);
  await sleep(250);
  const typed = await evalJs(`document.querySelector('${DIALOG} input')?.value ?? null`);
  const diag = await evalJs(`(() => {
    const dlgs = [...document.querySelectorAll('${DIALOG}')];
    return JSON.stringify({
      dialogCount: dlgs.length,
      // marker 是上一个视图在自己弹窗节点上打的戳：还在同一个节点上就说明这个弹窗实例（或它的 DOM）跨视图活下来了
      markers: dlgs.map((d) => d.dataset.marker ?? null),
      inputs: dlgs.map((d) => [...d.querySelectorAll("input")].map((i) => i.value)),
      roots: document.querySelectorAll('[data-slot="dialog"]').length,
    });
  })()`);
  assert(
    typed === value,
    `${chip}：值「${value}」填进「改成」输入框（打字前框里是 ${JSON.stringify(preType)}，实拿 ${JSON.stringify(typed)}，上一视图留下的戳 ${JSON.stringify(inherited)}，取证 ${diag}）`,
  );

  const before = await cellsOf(ids.hostId, ids.fields.note);
  const applyPt = await center(
    `[...document.querySelectorAll('${DIALOG} button')].find(b => /^(应用|Apply)$/.test(b.textContent.trim()))`,
  );
  await clickAt(applyPt.x, applyPt.y, 500);
  await waitFor(async () => !(await evalJs(`!!document.querySelector('${DIALOG}')`)), "dialog closes after apply");
  // 成功 toast 会盖住下一个视图弹窗的落点，切视图前等它散尽
  await waitFor(
    async () => (await evalJs(`document.querySelectorAll('[data-sonner-toast]').length`)) === 0,
    "toasts dismissed",
    20,
    400,
  );
  assert(!(await isRinged(a)) && !(await isRinged(b)), `${chip}：落库后选中圈清掉（apply() 里那句 clear() 真机生效）`);

  const after = await cellsOf(ids.hostId, ids.fields.note);
  const hit = Object.keys(after)
    .filter((r) => after[r] === value)
    .sort();
  assert(
    JSON.stringify(hit) === JSON.stringify([a, b].sort()),
    `${chip}：新值只落在勾选的两行（实拿 ${JSON.stringify(hit)}）`,
  );
  const collateral = Object.keys(after).filter(
    (r) => !hit.includes(r) && JSON.stringify(after[r]) !== JSON.stringify(before[r] ?? null),
  );
  assert(collateral.length === 0, `${chip}：没勾选的行一格没动（被动了 ${JSON.stringify(collateral)}）`);
  return { chip, selected: [a, b], title, badge: bulk.badge };
}

/** 右键勾一行（菜单首项就是这行的开关，选中态与未选中态走同一个项） */
async function toggleRow(rowId) {
  const pt = await center(`document.querySelector('[data-row-id="${rowId}"]')`);
  if (!pt) throw new Error("ROW_NOT_VISIBLE: " + rowId);
  await rightClickAt(pt.x, pt.y);
  await waitFor(() => ctxItem(`row-ctx-toggle-${rowId}`), "menu for " + rowId);
  const item = await center(`document.querySelector('${MENU} [data-testid="row-ctx-toggle-${rowId}"]')`);
  await clickAt(item.x, item.y, 300);
}

/**
 * 落差的第二条取证：同一个视图里「批量修改」取消后再开，字段与草稿还在不在。
 * BulkEditDialog 组件不随弹窗开合卸载（只有内容 DOM 重挂），而重置那条 useEffect 只认 [field]，
 * 所以字段没换时旧草稿会原样留着。这里全程不落库（只点取消），把现状钉下来；是留还是清属于产品取舍。
 */
async function stickyDraft(ids) {
  const DRAFT = "sticky-draft";
  await clickChip(ids.derived.list.chip);
  await waitFor(hasRows(2), "list rows for sticky probe");
  const [a, b] = await rowIdsInDom();
  await toggleRow(a);
  await toggleRow(b);
  const read = async () =>
    evalJs(`(() => {
      const d = document.querySelector('${DIALOG}');
      if (!d) return null;
      const sel = d.querySelector('select');
      const inp = d.querySelector('input');
      return {
        field: sel?.options[sel.selectedIndex]?.text ?? null,
        draft: inp ? inp.value : null,
        title: d.querySelector('[data-slot="dialog-title"]')?.textContent.trim() ?? null,
      };
    })()`);
  const cancel = async () => {
    const pt = await center(
      `[...document.querySelectorAll('${DIALOG} button')].find(b => /^(取消|Cancel)$/.test(b.textContent.trim()))`,
    );
    await clickAt(pt.x, pt.y, 400);
    await waitFor(async () => !(await evalJs(`!!document.querySelector('${DIALOG}')`)), "dialog closes on cancel");
  };

  const open = async () => {
    const pt = await center(`document.querySelector('[data-row-id="${a}"]')`);
    await rightClickAt(pt.x, pt.y);
    await waitFor(() => ctxItem("row-ctx-bulk-edit"), "bulk item for sticky probe");
    const item = await center(`document.querySelector('${MENU} [data-testid="row-ctx-bulk-edit"]')`);
    await clickAt(item.x, item.y, 500);
    await waitFor(() => evalJs(`!!document.querySelector('${DIALOG}')`), "bulk dialog opens (sticky)");
  };

  await open();
  // 全新挂载的弹窗：字段落在第一个可编辑列（名称），草稿框空着
  const fresh = await read();
  await evalJs(`(() => {
    const sel = document.querySelector('${DIALOG} select');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, ${JSON.stringify(ids.fields.note)});
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(250);
  await evalJs(`(() => { document.querySelector('${DIALOG} input').focus(); return true; })()`);
  await insertText(DRAFT);
  await sleep(250);
  const beforeClose = await read();
  await cancel();
  await open();
  const again = await read();
  await cancel();

  assert(
    fresh.draft === "" && fresh.field !== NOTE,
    `新挂载的弹窗是干净的（字段「${fresh.field}」、框里 ${JSON.stringify(fresh.draft)}）`,
  );
  assert(
    again.draft === beforeClose.draft && again.field === beforeClose.field,
    `同一个视图里「取消 → 再开」，字段停在「${again.field}」、草稿框仍是「${again.draft}」（关之前是「${beforeClose.field}」/「${beforeClose.draft}」）`,
  );
  await toggleRow(a);
  await toggleRow(b);
  return { freshField: fresh.field, reopenedField: again.field, reopenedDraft: again.draft };
}

/**
 * 落差②取证：卡片既是拖拽源又挂右键。
 * 断言只打「右键按住拖动不得启动拖拽」；左键拖能否起 dragstart 只记录——CDP 送不进 HTML5 DnD 是工具口径，不是产品结论。
 * 时间线另说：它的拖拽是 onPointerDown 手写的，不吃 draggable 属性，右键按下去会不会把 beginDrag 一起唤起，正是这条链最可能出岔的地方。
 */
async function dragCoexistence(ids) {
  const drag = {};
  await evalJs(
    `window.__dragStart = 0; document.addEventListener('dragstart', () => { window.__dragStart++; }, true);`,
  );
  for (const key of ["board", "calendar"]) {
    const chip = ids.derived[key].chip;
    await clickChip(chip);
    await waitFor(hasRows(1), chip + " rows");
    const rowId = (await rowIdsInDom())[0];
    const pt = await center(`document.querySelector('[data-row-id="${rowId}"]')`);
    const attrs = await evalJs(`(() => {
      const el = document.querySelector('[data-row-id="${rowId}"]');
      return { self: el.getAttribute('draggable'), anyAncestor: !!el.closest('[draggable="true"]') };
    })()`);
    const before = await evalJs("window.__dragStart");
    await rightMouse("mouseMoved", pt.x, pt.y);
    await rightMouse("mousePressed", pt.x, pt.y);
    await sleep(200);
    await rightMouse("mouseMoved", pt.x + 24, pt.y + 8);
    await sleep(150);
    await rightMouse("mouseReleased", pt.x + 24, pt.y + 8);
    await sleep(300);
    const fired = (await evalJs("window.__dragStart")) - before;
    drag[key] = { ...attrs, dragstartOnRightDrag: fired };
    assert(fired === 0, `${chip}：右键按住拖动没有触发 dragstart（卡片 draggable=${attrs.self}）`);
    await escape();
    await sleep(200);
  }

  const chip = ids.derived.timeline.chip;
  await clickChip(chip);
  await waitFor(hasRows(1), "timeline rows");
  const rowId = (await rowIdsInDom())[0];
  const pt = await center(`document.querySelector('[data-row-id="${rowId}"]')`);
  const dateCell = () =>
    evalJs(`(async () => {
      const cells = await window.__TAURI_INTERNALS__.invoke('cells_load', { viewId: ${JSON.stringify(ids.hostId)} });
      const c = cells.find(x => x.row_id === ${JSON.stringify(rowId)} && x.field_id === ${JSON.stringify(ids.fields.date)});
      return c ? c.value : null;
    })()`);
  const dateBefore = await dateCell();
  await rightMouse("mouseMoved", pt.x, pt.y);
  await rightMouse("mousePressed", pt.x, pt.y);
  await sleep(200);
  await mouse("mouseMoved", pt.x + 40, pt.y);
  await sleep(200);
  await rightMouse("mouseReleased", pt.x + 40, pt.y);
  await sleep(400);
  const dateAfter = await dateCell();
  const menuOpen = await ctxItem(`row-ctx-toggle-${rowId}`);
  drag.timeline = {
    rightDragMovedPx: 40,
    dateBefore,
    dateAfter,
    dateCellChanged: dateBefore !== dateAfter,
    contextMenuOpenAfterRightDrag: !!menuOpen,
  };
  assert(
    dateBefore === dateAfter,
    `时间线：右键按住横拖 40px 没有把日期条拖走（${dateBefore} → ${dateAfter}），菜单仍开着=${!!menuOpen}`,
  );
  await escape();
  await sleep(200);
  return drag;
}

const out = { views: [], sandbox: null, fail: null };
let hostId = null;
let chainDone = false;

try {
  await waitFor(ready, "APP_NOT_READY");
  // 用户开着的标签一个不关：只在自己建的那一页上做事，收尾时关掉沙箱标签
  out.purgedBefore = await purgeScratch();
  const ids = await provision();
  hostId = ids.hostId;
  out.sandbox = { hostId: ids.hostId, fields: ids.fields, rows: ids.rows };

  reload();
  await sleep(2500);
  await waitFor(ready, "APP_READY_AFTER_PROVISION");
  const node = await center(`document.querySelector('[data-tree-row="${ids.hostId}"]')`);
  if (!node) throw new Error("SANDBOX_NOT_IN_TREE");
  await clickAt(node.x, node.y, 1200);
  await waitFor(
    async () => (await evalJs("document.querySelectorAll('[role=tablist] button').length")) >= 5,
    "view chips",
  );

  for (const v of VIEWS) {
    await clickChip(v.chip);
    // 日历把一个日期只铺 2 行（第 3 行起折成「查看全部」），4 行同一天时 DOM 里只有 2 个行锚点
    await waitFor(hasRows(2), v.chip + " renders rows");
    out.views.push(await smokeView(v.chip, v.value, ids));
  }
  out.sticky = await stickyDraft(ids);
  out.drag = await dragCoexistence(ids);
  chainDone = true;
} catch (e) {
  out.fail = String(e && e.message ? e.message : e);
} finally {
  if (hostId) {
    // 先关掉沙箱标签再硬删：留着一个指向已删视图的标签，重载后只会给用户多一块错误面板
    out.tabClosed = await evalJs(`(() => {
      const el = document.querySelector('[data-tab-id="${hostId}"] [data-testid="tab-close"]');
      if (el) el.click();
      return !!el;
    })()`).catch(() => false);
    out.purgedAfter = await purgeScratch().catch((e) => "PURGE_FAILED: " + e.message);
    out.leftover = await evalJs(`(async () => {
      const inv = window.__TAURI_INTERNALS__.invoke;
      const wss = await inv('workspace_list', {});
      for (const w of wss) {
        const views = await inv('view_list_by_workspace', { workspaceId: w.id });
        const hit = views.find(v => v.name === ${JSON.stringify(SCRATCH)});
        if (hit) return 'LEFTOVER:' + hit.id;
      }
      return 'none';
    })()`).catch(() => "UNKNOWN");
    reload();
  }
}

console.log("\n" + JSON.stringify(out, null, 2));
await sleep(1200);
if (out.fail) {
  console.log("\nEXCEPTIONS(" + exceptions.length + "):\n" + exceptions.slice(0, 6).join("\n---\n"));
  await ws.close();
  process.exit(1);
}
assert(out.leftover === "none", "沙箱表已清干净：" + out.leftover);
if (chainDone) assert(exceptions.length === 0, "整条链零未捕获异常，实测 " + exceptions.length + " 条");
console.log("\nROW_BULK_SMOKE_PASS views=" + out.views.length);
await ws.close();
process.exit(0);
