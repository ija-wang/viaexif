/* Capture the landing screens and both templates in dark + light theme. */
import { spawn } from "node:child_process";
import { writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://127.0.0.1:8098";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = 9455;
const OUT = path.resolve("tests/.tmp");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await mkdir(OUT, { recursive: true });
const profile = await mkdtemp(path.join(tmpdir(), "vx-shot-"));
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
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
  }
};
const send = (method, params = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((res, rej) => pending.set(i, { resolve: res, reject: rej })); };
const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const shot = async (name) => {
  const png = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(path.join(OUT, `${name}.png`), Buffer.from(png.data, "base64"));
  console.log("saved", name);
};

try {
  await send("Page.enable");
  await send("DOM.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });

  await send("Page.navigate", { url: `${BASE}/?theme=dark` });
  await sleep(2200);
  await shot("shot-home-dark");

  await send("Page.navigate", { url: `${BASE}/?theme=light` });
  await sleep(2200);
  await shot("shot-home-light");

  await send("Page.navigate", { url: `${BASE}/?theme=dark` });
  await sleep(1800);
  const doc = await send("DOM.getDocument", { depth: -1 });
  const { nodeId } = await send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#fileInput" });
  await send("DOM.setFileInputFiles", {
    nodeId,
    files: ["tests/fixtures/live/IMG_0001.HEIC", "tests/fixtures/live/IMG_0001.MOV"].map((p) => path.resolve(p)),
  });
  await sleep(2500);
  await evaluate(`document.getElementById('brandBtn').click(); 'opened'`);
  await sleep(500);
  await shot("shot-menu-dark");
  await evaluate(`document.getElementById('brandBtn').click(); 'closed'`);
  await sleep(300);
  await shot("shot-classic-dark");

  await evaluate(`document.querySelector('.tpl[data-tpl="blur"]').click(); 'blur'`);
  await sleep(700);
  await shot("shot-blur-dark");

  await evaluate(`document.querySelector('.tpl[data-tpl="classic"]').click();
    document.documentElement.dataset.theme = 'light'; localStorage.setItem('vx-theme','light'); 'light'`);
  await sleep(500);
  await shot("shot-classic-light");
} finally {
  ws.close();
  browser.kill();
}
process.exit(0);
