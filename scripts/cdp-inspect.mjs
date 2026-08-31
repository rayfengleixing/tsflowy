// M1 验收辅助脚本：通过 WebView2 远程调试端口读取应用页面渲染文本。
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
  ws.onerror = (e) => rej(new Error("ws error"));
});
ws.send(
  JSON.stringify({
    id: 1,
    method: "Runtime.evaluate",
    params: { expression: "document.body.innerText", returnByValue: true },
  }),
);
const result = await new Promise((res) => {
  ws.onmessage = (e) => res(JSON.parse(e.data));
});
console.log("PAGE_TEXT:");
console.log(result.result?.result?.value ?? JSON.stringify(result));
ws.close();
process.exit(0);
