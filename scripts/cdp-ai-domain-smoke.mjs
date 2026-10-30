// AI 域五层（lib/ai · lib/ai-edit · lib/ai-tools · stores/ai · features/ai）的真机取证。
// 补的是 P5 收口后那条「三批纯移动只有逐字节比对、没有运行时证据」的欠账：
// run-stream.ts（6a 切出）、tokens.ts（7 下沉）、turn-registry.ts（8 容器化）在 jsdom 里有用例，
// 但在真浏览器 + 真 IPC 的图里「装配得起来」这件事从来没跑过。
//
// 观测口径四条，全部只读，不动用户数据：
//   1. 深路径 import() 真求值——证明运行期模块图解析得到新位置（比 tsc 硬，tsc 只看类型图）；
//   2. 旧平路径 import() 必须 reject——反证没留兼容垫片（barrel / re-export 旧名）；
//   3. 动作协议在真实运行时里往返一次——buildEditSystemPrompt 写出来的块，extractCalls/extractEdit 读得回来；
//   4. 只读 IPC 走 lib 的包装函数（aiGetConfig / aiSessionList / aiUsageSummary），
//      再 openPanel/closePanel 真开真关一次面板，钉住 stores→features 那层接缝。
// ai_chat / ai_test_connection / ai_list_models 会打外网、ai_*_save 会写库，一律不碰。
//
// 前置: WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 npm run tauri dev
// 用法: node scripts/cdp-ai-domain-smoke.mjs
// 输出: 每条断言一行 ok -，末尾 AI_DOMAIN_SMOKE_PASS / 抛错退出非 0（stdout 走管道，UTF-8）
const BASE = "http://127.0.0.1:9222";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ws = new WebSocket(
  (await (await fetch(`${BASE}/json`)).json()).find((x) => x.type === "page").webSocketDebuggerUrl,
);
await new Promise((r) => (ws.onopen = r));
let msgId = 0;
const pending = new Map();
const exceptions = [];
let assertions = 0;
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
    const flat = expr.replace(/\s+/g, " ").slice(0, 260);
    throw new Error(
      "EVAL: " + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails) + " || " + flat,
    );
  }
  return r.result?.value;
};
const assert = (cond, msg) => {
  if (!cond) throw new Error("ASSERT: " + msg);
  assertions += 1;
  console.log("ok - " + msg);
};
async function waitFor(fn, desc, tries = 30, gap = 300) {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return;
    await sleep(gap);
  }
  throw new Error("TIMEOUT: " + desc);
}

/** 在页面里跑一段 async IIFE；EXPR 用 ${} 插值时要注意引号 */
const page = (body) => evalJs(`(async () => { ${body} })()`);

/**
 * 深路径求值：一次 import() 一个模块，回它的导出名清单。
 * 走 dev 的 Vite（同源 http://localhost:1420），路径必须带扩展名——浏览器不认 `@/` 别名。
 * reject 必须在页面里就地接住：让 promise 一路抛出来会污染 exceptionThrown 收集器，
 * 那三条「旧路径应当解析不到」的反证就会伪装成「产品有未捕获异常」。
 */
const load = (path) =>
  page(`
    try {
      const m = await import("${path}");
      return { ok: true, keys: Object.keys(m).sort() };
    } catch (e) {
      return { ok: false, err: String((e && e.message) || e).slice(0, 160) };
    }
  `);

// —— 1. 五层各取一处，深路径 import() 必须求值成功 ——
const LAYERS = [
  { path: "/src/lib/ai/index.ts", need: ["aiGetConfig", "aiSessionList", "aiUsageSummary", "estimateAiCost"] },
  { path: "/src/lib/ai/profile.ts", need: ["AI_PROVIDER_PRESETS", "aiProfileKeyInput"] },
  { path: "/src/lib/ai/ai-editor.ts", need: ["registerAiEditor", "getAiEditorForView"] },
  { path: "/src/lib/ai/ai-locate.ts", need: ["asDoc"] },
  { path: "/src/lib/ai/ai-mention.ts", need: ["parseMentions", "detectMentionQuery", "mentionScore"] },
  {
    path: "/src/lib/ai-edit/index.ts",
    need: ["EDIT_BLOCK_TAG", "CALL_BLOCK_TAG", "buildEditSystemPrompt", "extractCalls", "validateCall"],
  },
  { path: "/src/lib/ai-tools/index.ts", need: ["aiToolSpecs", "runRetrievalCall", "runWriteAction", "coerceCell"] },
  { path: "/src/stores/ai/index.ts", need: ["useAiStore"] },
  // P5-6a 切出去的那份 agent 循环：纯移动，此前只有逐字节比对
  { path: "/src/stores/ai/run-stream.ts", need: ["createRunStream"] },
  // P5-7 下沉的那份 token 估算
  { path: "/src/stores/ai/tokens.ts", need: ["estimateTokens", "tailTokens"] },
  // P5-8 容器化的轮次登记
  { path: "/src/stores/ai/turn-registry.ts", need: ["createTurnRegistry"] },
  { path: "/src/features/ai/AiPanel.tsx", need: ["AiPanel"] },
];
for (const l of LAYERS) {
  const r = await load(l.path);
  assert(r && r.ok === true, `深路径求值成功：${l.path}${r && r.ok ? "" : " | " + (r && r.err)}`);
  const missing = l.need.filter((k) => !(r.keys || []).includes(k));
  assert(
    missing.length === 0,
    `${l.path} 的导出面含 ${l.need.join(" / ")}${missing.length ? " | 缺 " + missing.join(",") : ""}`,
  );
}

// —— 2. 旧平路径必须 import 不到（反证没留垫片）——
const OLD = ["/src/lib/ai.ts", "/src/lib/ai-edit.ts", "/src/lib/ai-tools.ts", "/src/stores/ai.ts"];
for (const p of OLD) {
  const r = await load(p);
  assert(r.ok === false, `旧平路径按预期解析不到：${p}`);
}

// —— 3. 动作协议在真实运行时里往返 ——
const roundtrip = await page(`
  const ed = await import("/src/lib/ai-edit/index.ts");
  const prompt = ed.buildEditSystemPrompt({ title: "冒烟页", selection: "选中的字", pageText: "整页文字" });
  const openLine = "\`\`\`" + ed.EDIT_BLOCK_TAG + "\\n";
  const payload = '{"tool":"apply_edit","args":{"op":"replace_selection","summary":"冒注","content":"新内容"}}';
  const sample = prompt + "\\n" + openLine + payload + "\\n\`\`\`";
  const edit = ed.extractEdit(sample).edit;
  const callOpen = "\`\`\`" + ed.CALL_BLOCK_TAG + "\\n";
  const calls = ed.extractCalls("答案\\n\\n" + callOpen + '{"tool":"search_workspace","args":{"query":"关键词"}}\\n\`\`\`');
  return {
    hasOpenLine: prompt.includes(openLine),
    editTool: edit ? edit.tool : null,
    editOp: edit && edit.args ? edit.args.op : null,
    editContent: edit && edit.args ? edit.args.content : null,
    malformed: edit === null,
    callTool: calls.calls && calls.calls[0] ? calls.calls[0].tool : null,
    callCount: (calls.calls || []).length,
    tags: [ed.EDIT_BLOCK_TAG, ed.CALL_BLOCK_TAG],
  };
`);
assert(roundtrip.hasOpenLine === true, "buildEditSystemPrompt 下发的协议里含「围栏 + 编辑块标记 + 换行」的整行开栏");
assert(
  roundtrip.tags[0] === "tsflowy-edit" && roundtrip.tags[1] === "tsflowy-call",
  "两个块标记仍是 tsflowy-edit / tsflowy-call（旧会话与旧配置依赖这两个名字）",
);
assert(
  roundtrip.editTool === "apply_edit" && roundtrip.editOp === "replace_selection",
  "协议写出的动作块被 extractEdit 读回同一条 op（真运行时里往返成功）",
);
assert(roundtrip.editContent === "新内容", "extractEdit 读回的 content 与写入一致");
assert(
  roundtrip.callTool === "search_workspace" && roundtrip.callCount === 1,
  "检索请求块被 extractCalls 读回 1 条且 tool 正确",
);

// —— 4. 只读 IPC 走 lib 包装 ——
const ipc = await page(`
  const ai = await import("/src/lib/ai/index.ts");
  const cfg = await ai.aiGetConfig();
  const sessions = await ai.aiSessionList();
  const usage = await ai.aiUsageSummary();
  const cost = ai.estimateAiCost({ prompt: 1000, completion: 500 }, 1, 2);
  return {
    cfgKeys: Object.keys(cfg || {}).length,
    hasProvider: !!(cfg && (cfg.provider || cfg.base_url)),
    isArray: Array.isArray(sessions),
    sessionCount: sessions.length,
    usageSessions: usage ? usage.sessions : null,
    usageTokens: usage ? usage.prompt_tokens + usage.completion_tokens : null,
    cost: cost,
    costText: typeof ai.formatAiCost === "function" ? ai.formatAiCost(cost || 0) : null,
  };
`);
assert(ipc.cfgKeys > 0 && ipc.hasProvider, `ai_get_config 经 lib/ai 包装打得通（字段 ${ipc.cfgKeys} 个）`);
assert(ipc.isArray, `ai_session_list 回数组（${ipc.sessionCount} 条会话，只读不写）`);
assert(
  typeof ipc.usageSessions === "number",
  `ai_usage_summary 回 sessions=${ipc.usageSessions}（数字，不是 undefined）`,
);
assert(
  ipc.cost === 0.002 && typeof ipc.costText === "string",
  "estimateAiCost / formatAiCost 在新路径上算得对（1000+500 token、每百万 1/2 → 0.002）",
);

// —— 5. 面板真开真关：钉 stores→features 那层接缝 ——
const before = await page(`
  const s = await import("/src/stores/ai/index.ts");
  window.__aiSmoke = s.useAiStore;
  return { open: !!s.useAiStore.getState().open, hasActions: typeof s.useAiStore.getState().openPanel === "function" };
`);
assert(before.hasActions === true, "useAiStore 装配出来的动作面里有 openPanel（九份切片的装配在真浏览器里跑通了）");
await page(`window.__aiSmoke.getState().openPanel(); return true;`);
await waitFor(
  () => page(`return !!document.querySelector('[data-testid="ai-panel"] textarea');`),
  "AI 面板开起来并渲染出输入框",
);
assert(
  await page(`return !!document.querySelector('[data-testid="ai-panel"] textarea');`),
  "openPanel 之后真窗口里渲染出面板与输入框（stores/ai → features/ai 的接缝在真运行时接得上）",
);
const inner = await page(`
  const panel = document.querySelector('[data-testid="ai-panel"]');
  return { label: panel.getAttribute("aria-label") || "", buttons: panel.querySelectorAll("button").length };
`);
assert(
  inner.buttons >= 3,
  `面板里有 ${inner.buttons} 个按钮（快捷动作 / 附件 / 发送等都挂上了，标题「${inner.label}」）`,
);
await page(`window.__aiSmoke.getState().closePanel(); return true;`);
await waitFor(
  async () => !(await page(`return !!document.querySelector('[data-testid="ai-panel"] textarea');`)),
  "AI 面板收起",
);
assert(
  await page(`const s = await import("/src/stores/ai/index.ts"); return s.useAiStore.getState().open === false;`),
  "closePanel 之后 store 的 open 落回 false（面板不是靠 DOM 遮住的）",
);
await page(`delete window.__aiSmoke; return true;`);

// —— 收尾：不许有任何未捕获异常 ——
assert(exceptions.length === 0, `整轮零未捕获异常（Runtime.exceptionThrown ${exceptions.length} 条）`);
console.log(`\nAI_DOMAIN_SMOKE_PASS assertions=${assertions} modules=${LAYERS.length} exceptions=${exceptions.length}`);
ws.close();
