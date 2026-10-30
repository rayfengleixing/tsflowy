// P6「src/lib 根 75 个散模块归进 11 个目录」的真机取证（2026-10-30 首次以探针 .p6-smoke-probe.js 跑通，
// 本脚本是它的 standalone 版：断言失败即退出非 0，可反复跑，也可发给后来人自己跑一遍）。
//
// 为什么值得为一次纯 git mv 跑真窗口：`tsc` 只验类型图，`vitest` 只验 node/jsdom 里的解析；
// 而浏览器打包图是第三条独立的路——深路径写错、大小写、目录 index 解析差异，都只在这里现形。
// 所以证据形状就三条：
//   1. 搬家后的深路径 import() 必须逐条求值成功（模块体真执行，不只是文件在）；
//   2. 旧平路径必须解析不到——反证没有别名/残留把老路兜住了（那样「搬家」是假的）；
//   3. 只读 IPC + 真库渲染：证明搬家后的模块链在真 Tauri 里打得到 Rust，界面真的画出行来。
// 全程不写库：只点列举与读取命令，视图页签点击是纯切换，不点「新建视图」（点下去就是写库）。
//
// 前置: WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 npm run tauri dev
// 用法: node scripts/cdp-lib-layout-smoke.mjs
// 输出: 每条断言一行 ok -，末尾 LIB_LAYOUT_SMOKE_PASS pass=/skip=/windowErrors=
const BASE = "http://127.0.0.1:9222";

const ws = new WebSocket(
  (await (await fetch(`${BASE}/json`)).json()).find((x) => x.type === "page").webSocketDebuggerUrl,
);
await new Promise((r) => (ws.onopen = r));
let msgId = 0;
let assertions = 0;
let skipped = 0;
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
    throw new Error("EVAL: " + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails));
  }
  return r.result?.value;
};
const page = (body) => evalJs(`(async () => { ${body} })()`);
const assert = (cond, msg) => {
  if (!cond) throw new Error("ASSERT: " + msg);
  assertions += 1;
  console.log("ok - " + msg);
};
/** skip 不判红也不判绿：它记的是「这台机器的数据形状撑不起这条断言」，末尾照实报数 */
const skip = (msg) => {
  skipped += 1;
  console.log("skip - " + msg);
};

// 模块求值期与事件回调期的异常只到 window error / unhandledrejection，进不了 try/catch，先装收集器
await page(`
  window.__layoutErrs = window.__layoutErrs || [];
  if (!window.__layoutHooked) {
    window.__layoutHooked = true;
    window.addEventListener("error", (e) => window.__layoutErrs.push(String(e.message)));
    window.addEventListener("unhandledrejection", (e) => window.__layoutErrs.push("rejection: " + String(e && e.reason)));
  }
  return true;
`);
assert(await page(`return document.querySelectorAll("#root *").length > 0;`), "界面已挂载（#root 有子节点）");

// —— 1. 搬家后的深路径逐条求值 ——
// 每个目录至少一条，外加留在根上的收口件与 P6-2 并入 ai/ 的那三件；symbols 只在这几条有把握地核对
const MOVED = [
  ["app-context（刻意留根）", "/src/lib/app-context.ts", ["appLang", "appTree", "appReload"]],
  ["i18n（刻意留根）", "/src/lib/i18n.ts", ["t"]],
  ["database/", "/src/lib/database/field-kinds.ts", null],
  ["database/（值与查询）", "/src/lib/database/database-values.ts", null],
  ["database/（查询）", "/src/lib/database/database-query.ts", null],
  ["database/（视图配置）", "/src/lib/database/view-config.ts", null],
  ["database/（条件格式）", "/src/lib/database/database-cond-format.ts", null],
  ["doc/", "/src/lib/doc/tree.ts", null],
  ["doc/（文档）", "/src/lib/doc/documents.ts", null],
  ["transfer/", "/src/lib/transfer/export-page.ts", null],
  ["transfer/（csv）", "/src/lib/transfer/csv.ts", null],
  ["transfer/（库传输）", "/src/lib/transfer/db-transfer.ts", null],
  ["search/", "/src/lib/search/search.ts", null],
  ["sync/", "/src/lib/sync/auto-sync.ts", null],
  ["desktop/", "/src/lib/desktop/update-check.ts", null],
  ["assets/", "/src/lib/assets/attachment-kind.ts", null],
  ["backend/", "/src/lib/backend/db.ts", null],
  ["ipc/", "/src/lib/ipc/ipc-core.ts", null],
  ["render/", "/src/lib/render/katex-render.ts", null],
  ["ai/（含 P6-2 并入的三件）", "/src/lib/ai/index.ts", null],
  ["ai/ai-editor（并入件）", "/src/lib/ai/ai-editor.ts", ["registerAiEditor"]],
  ["ai/ai-locate（并入件）", "/src/lib/ai/ai-locate.ts", ["asDoc"]],
  ["ai/ai-mention（并入件）", "/src/lib/ai/ai-mention.ts", ["parseMentions"]],
];
for (const [label, path, symbols] of MOVED) {
  const r = await page(`
    try {
      const m = await import("${path}");
      const keys = Object.keys(m);
      const missing = ${JSON.stringify(symbols || [])}.filter((s) => !(s in m));
      return { ok: keys.length > 0 && missing.length === 0, n: keys.length, missing: missing.join(",") };
    } catch (e) {
      return { ok: false, err: String((e && e.message) || e).slice(0, 140) };
    }
  `);
  assert(r.ok === true, `深路径求值成功：${label} → ${path}${r.ok ? "（" + r.n + " 个导出）" : " | " + r.err}`);
  // 导出名核对单独一条：漏一个符号不该被「模块能 import」混过去
  assert(r.ok && !(r.missing || ""), `${label} 的导出面含 ${symbols ? symbols.join(" / ") : "至少一个值导出"}`);
}

// —— 2. 反证：旧平路径必须解析不到 ——
for (const old of [
  "/src/lib/field-kinds.ts",
  "/src/lib/export-page.ts",
  "/src/lib/documents.ts",
  "/src/lib/database-cond-format.ts",
]) {
  const r = await page(`
    try { await import("${old}"); return { still: true }; }
    catch (e) { return { still: false }; }
  `);
  assert(r.still === false, `旧平路径按预期解析不到：${old}`);
}

// —— 3. 只读 IPC：搬家后的模块链在真 Tauri 里打得到 Rust ——
const ipc = await page(`
  const inv = (c, a) => window.__TAURI_INTERNALS__.invoke(c, a || {});
  const out = {};
  try { const l = await inv("workspace_list"); out.workspaces = Array.isArray(l) ? l.length : 0; out.wsId = out.workspaces ? String(l[0].id ?? l[0].workspaceId ?? "") : null; } catch (e) { out.workspaces = -1; }
  try { const d = await inv("doc_list_all"); out.docs = Array.isArray(d) ? d.length : -1; } catch (e) { out.docs = -1; }
  try { out.prefs = Object.keys((await inv("get_prefs")) || {}).length; } catch (e) { out.prefs = -1; }
  try { const b = await inv("list_backups"); out.backups = Array.isArray(b) ? b.length : -1; } catch (e) { out.backups = -1; }
  return out;
`);
assert(ipc.workspaces > 0, `workspace_list 打得通（${ipc.workspaces} 个工作区）`);
assert(ipc.docs >= 0, `doc_list_all 打得通（${ipc.docs} 篇文档，只读）`);
assert(ipc.prefs > 0, `get_prefs 回 ${ipc.prefs} 个键`);
assert(ipc.backups >= 0, `list_backups 回 ${ipc.backups} 个备份档（只点列举，未触发导出）`);

// —— 4. 真库渲染：页签切换后行节点在不在（纯切换，不建不写）——
const rowProbe = async () =>
  page(
    `return { rows: document.querySelectorAll("[data-row-id]").length, tree: document.querySelectorAll("[data-tree-row]").length };`,
  );
const now = await rowProbe();
assert(now.tree > 0, `页面树里有 ${now.tree} 个 [data-tree-row] 节点（当前工作区真渲染出来了）`);
for (const want of ["列表", "看板"]) {
  const clicked = await page(`
    const els = [...document.querySelectorAll("button, [role='tab'], a")];
    const el = els.find((e) => (e.textContent || "").trim() === "${want}" || (e.getAttribute("title") || "") === "${want}");
    if (!el) return false;
    el.click();
    return true;
  `);
  if (!clicked) {
    skip(`没有「${want}」页签可点（当前屏没打开数据库视图）——不新建视图，点下去就是写库`);
    continue;
  }
  await new Promise((r) => setTimeout(r, 700));
  const after = await rowProbe();
  if (after.rows === 0) skip(`点了「${want}」但本屏没有 [data-row-id]（该工作区没有带行的表）`);
  else assert(after.rows > 0, `切到「${want}」后渲染出 ${after.rows} 个 [data-row-id] 行节点`);
}

// —— 收尾：两类收集器都得是空的 ——
const winErrs = await page(`return (window.__layoutErrs || []).slice(0, 15);`);
assert(
  Array.isArray(winErrs) && winErrs.length === 0,
  `window error / unhandledrejection 零记录（${winErrs ? winErrs.length : "取不到"} 条）`,
);
assert(exceptions.length === 0, `Runtime.exceptionThrown 零条（${exceptions.length} 条）`);
await page(`delete window.__layoutErrs; delete window.__layoutHooked; return true;`);

console.log(
  `\nLIB_LAYOUT_SMOKE_PASS assertions=${assertions} skip=${skipped} windowErrors=0 exceptions=0 modules=${MOVED.length}`,
);
ws.close();
