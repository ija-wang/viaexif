/* Print the ink box of every top-level shape in one SVG — used to repair the
 * truncated Insta360 wordmark (its lowercase "i" never made it into the export).
 *
 *   node tools/inspect-ink.mjs web/assets/brands/insta360.svg
 */
import { spawn } from "node:child_process";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const target = process.argv[2];
if (!target) throw new Error("usage: node tools/inspect-ink.mjs <file.svg>");
const EDGE = process.env.EDGE || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = Number(process.env.CDP_PORT || 9353);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = await mkdtemp(path.join(tmpdir(), "vx-ink-"));
const browser = spawn(EDGE, [
  "--headless=new", "--disable-gpu", "--no-first-run",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "about:blank",
], { stdio: "ignore" });

async function targetWs() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* booting */ }
    await sleep(250);
  }
  throw new Error("CDP not ready");
}

const ws = new WebSocket(await targetWs());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result);
  }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  id += 1;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
await send("Runtime.enable");

const svg = await readFile(target, "utf8");
const res = await send("Runtime.evaluate", {
  expression: `(() => {
    document.body.innerHTML = '<div id="h" style="position:absolute;left:-99999px;top:0"></div>';
    document.getElementById('h').innerHTML = ${JSON.stringify(svg)};
    const root = document.querySelector('#h svg');
    const out = [];
    document.querySelectorAll('#h svg > path, #h svg > rect, #h svg > circle, #h svg > g > path').forEach((el, i) => {
      const b = el.getBBox();
      out.push({ i, tag: el.tagName, x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) });
    });
    return { viewBox: root.getAttribute('viewBox'), shapes: out };
  })()`,
  returnByValue: true,
});
if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails));
const { viewBox, shapes } = res.result.value;
console.log("viewBox", viewBox);
console.log("idx  x        y        w       h");
for (const s of shapes) {
  console.log(String(s.i).padEnd(4), String(s.x).padEnd(9), String(s.y).padEnd(9), String(s.w).padEnd(8), s.h);
}
ws.close();
browser.kill();
process.exit(0);
