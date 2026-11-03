/* =============================================================================
 * tools/ink-heights.mjs — measure the *ink* height each brand mark actually
 * occupies when drawn at a fixed box height.
 *
 * The viewBox is normalised to 200 tall by normalize-logos.mjs, but a viewBox is
 * a canvas, not the mark: this renders every file at HEIGHT px and scans the
 * alpha channel for the real ink bounding box, so "all logos are the same
 * height" stops being an assumption.
 *
 *   node tools/ink-heights.mjs
 * ========================================================================== */
import { spawn } from "node:child_process";
import { readdir, readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DIR = path.join(ROOT, "web/assets/brands");
const EDGE = process.env.EDGE || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = Number(process.env.CDP_PORT || 9356);
const HEIGHT = 200; // px the mark is drawn at
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = await mkdtemp(path.join(tmpdir(), "vx-ink-"));
const browser = spawn(EDGE, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--hide-scrollbars",
  "--window-size=1200,800", `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, "about:blank",
], { stdio: "ignore" });

async function target() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* booting */ }
    await sleep(250);
  }
  throw new Error("CDP endpoint not ready");
}

const ws = new WebSocket(await target());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let msgId = 0;
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
  msgId += 1;
  pending.set(msgId, { resolve, reject });
  ws.send(JSON.stringify({ id: msgId, method, params }));
});

await send("Runtime.enable");

const PAGE = String.raw`
window.__ink = (items) => Promise.all(items.map(({ file, data, aspect }) => new Promise((res) => {
  const img = new Image();
  img.onload = () => {
    const w = Math.max(1, Math.round(H * aspect));
    const c = document.createElement("canvas");
    c.width = w; c.height = H;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0, w, H);
    const px = g.getImageData(0, 0, w, H).data;
    let top = H, bot = -1, left = w, right = -1;
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < w; x += 1) {
        if (px[(y * w + x) * 4 + 3] > 16) {
          if (y < top) top = y;
          if (y > bot) bot = y;
          if (x < left) left = x;
          if (x > right) right = x;
        }
      }
    }
    res({ file, boxH: H, boxW: w, inkH: bot - top + 1, inkW: right - left + 1,
          top, bottom: H - 1 - bot, left, right: w - 1 - right });
  };
  img.onerror = () => res({ file, error: "load failed" });
  img.src = "data:image/svg+xml;base64," + data;
})));
`;
await send("Runtime.evaluate", {
  expression: `const H = ${HEIGHT};${PAGE}`,
  awaitPromise: false,
});

const files = (await readdir(DIR)).filter((f) => f.endsWith(".svg")).sort();
const items = [];
for (const f of files) {
  const raw = await readFile(path.join(DIR, f), "utf8");
  const vb = (raw.match(/viewBox="([^"]+)"/) || [])[1] || "0 0 1 1";
  const [, , w, h] = vb.split(/[\s,]+/).map(Number);
  items.push({ file: f, data: Buffer.from(raw, "utf8").toString("base64"), aspect: w / h });
}

const res = await send("Runtime.evaluate", {
  expression: `window.__ink(${JSON.stringify(items)})`,
  awaitPromise: true,
  returnByValue: true,
});
if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails));
const rows = res.result.value;

const pad = (s, n) => String(s).padEnd(n);
console.log("\n" + pad("file", 18) + pad("boxW", 8) + pad("inkH", 8) + pad("ratio", 8) + "top/bot/left/right pad");
console.log("-".repeat(76));
let bad = 0;
for (const r of rows) {
  if (r.error) { console.log(pad(r.file, 18) + "ERROR " + r.error); bad += 1; continue; }
  const ratio = (r.inkH / r.boxH).toFixed(4);
  const drift = Math.abs(r.inkH / r.boxH - 0.92) > 0.012;
  if (drift) bad += 1;
  console.log(pad(r.file, 18) + pad(r.boxW, 8) + pad(r.inkH, 8) + pad(ratio, 8) +
    `${r.top}/${r.bottom}/${r.left}/${r.right}` + (drift ? "   <-- off 0.92" : ""));
}
console.log(`\n${rows.length - bad}/${rows.length} marks fill 92% of their box height`);

ws.close();
browser.kill();
process.exit(0);
