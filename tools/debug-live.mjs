/* Debug probe: upload the live pair, dump HUD / toast / error state. */
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://127.0.0.1:8098";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = 9444;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = await mkdtemp(path.join(tmpdir(), "vx-dbg-"));
const browser = spawn(EDGE, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
  "--window-size=1600,1000", `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, "about:blank",
], { stdio: "ignore" });

let wsUrl;
for (let i = 0; i < 40; i += 1) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    wsUrl = list.find((t) => t.type === "page")?.webSocketDebuggerUrl;
    if (wsUrl) break;
  } catch { /* booting */ }
  await sleep(250);
}
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === "Runtime.exceptionThrown") console.log("EXC", m.params.exceptionDetails.exception?.description?.slice(0, 300));
  if (m.method === "Runtime.consoleAPICalled") {
    console.log("CONSOLE", m.params.type, m.params.args.map((a) => a.value ?? a.description).join(" ").slice(0, 300));
  }
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
};
const send = (method, params = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((res, rej) => pending.set(i, { resolve: res, reject: rej })); };
const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

try {
  await send("Page.enable");
  await send("DOM.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: `${BASE}/` });
  await sleep(1600);
  const doc = await send("DOM.getDocument", { depth: -1 });
  const { nodeId } = await send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#fileInput" });
  await send("DOM.setFileInputFiles", {
    nodeId,
    files: ["tests/fixtures/live/IMG_0001.HEIC", "tests/fixtures/live/IMG_0001.MOV"].map((p) => path.resolve(p)),
  });
  await sleep(2500);
  console.log("hud hidden:", await evaluate(`document.getElementById('hud').hidden`));
  console.log("hud label:", await evaluate(`document.getElementById('hudLabel').textContent`));
  console.log("hud transform:", await evaluate(`document.getElementById('hudFill').style.transform`));
  console.log("meta:", await evaluate(`document.getElementById('fileMeta').textContent`));
  console.log("stats:", await evaluate(`document.getElementById('statCount').textContent + ' | ' + document.getElementById('statSize').textContent`));
  console.log("btnLive hidden:", await evaluate(`document.getElementById('btnLive').hidden`));
  console.log("live obj:", await evaluate(`JSON.stringify({name: document.getElementById('fileMeta').textContent})`));
  const out = await evaluate(`(async () => {
    window.__errs = [];
    window.addEventListener('error', (e) => window.__errs.push(e.message));
    window.addEventListener('unhandledrejection', (e) => window.__errs.push('rej:' + e.reason));
    document.getElementById('toast').textContent = '';
    document.getElementById('btnLive').click();
    for (let i = 0; i < 50; i += 1) {
      if (document.getElementById('toast').textContent) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return { toast: document.getElementById('toast').textContent, errs: window.__errs };
  })()`);
  console.log("live export:", JSON.stringify(out));
} finally {
  ws.close();
  browser.kill();
}
process.exit(0);
