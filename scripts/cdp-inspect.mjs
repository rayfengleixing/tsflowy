// M 系列验收辅助脚本：通过 WebView2 远程调试端口对应用页面求值任意 JS。
// 用法: node scripts/cdp-inspect.mjs "<js expression>"   或   node scripts/cdp-inspect.mjs "@script.js"
import { readFileSync } from "node:fs";

const arg = process.argv[2] ?? "document.body.innerText";
const js = arg.startsWith("@") ? readFileSync(arg.slice(1), "utf8") : arg;

const base = "http://127.0.0.1:9222";
const list = await (await fetch(`${base}/json`)).json();
const page = list.find((p) => p.type === "page");
if (!page) {
  console.log("NO_PAGE_FOUND:", JSON.stringify(list));
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = () => rej(new Error("ws error"));
});
ws.send(
  JSON.stringify({
    id: 1,
    method: "Runtime.evaluate",
    params: { expression: js, returnByValue: true, awaitPromise: true },
  }),
);
const result = await new Promise((res) => {
  ws.onmessage = (e) => res(JSON.parse(e.data));
});
if (result.result?.exceptionDetails) {
  console.log("EXCEPTION:", JSON.stringify(result.result.exceptionDetails.exception?.description ?? result.result.exceptionDetails));
} else {
  console.log("RESULT:", JSON.stringify(result.result?.result?.value ?? null));
}
ws.close();
process.exit(0);
