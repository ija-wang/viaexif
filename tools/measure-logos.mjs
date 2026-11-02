/* =============================================================================
 * tools/measure-logos.mjs — prove the "logo height = 1/3 of the bar" rule.
 *
 * Renders every brand through the real app with the parameter line cleared, then
 * scans the rendered pixels: the mark is the widest ink run on the right half of
 * the bar, so its pixel height is measurable without touching renderer internals.
 *
 *   node tools/measure-logos.mjs
 * ========================================================================== */
import { spawn } from "node:child_process";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://127.0.0.1:8098";
const EDGE = process.env.EDGE || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = Number(process.env.CDP_PORT || 9354);
const FIXTURE = path.resolve("tests/fixtures/sample.jpg");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = await mkdtemp(path.join(tmpdir(), "vx-measure-"));
const browser = spawn(EDGE, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--hide-scrollbars",
  "--window-size=1600,1100", `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, "about:blank",
], { stdio: "ignore" });

async function wsUrl() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* booting */ }
    await sleep(250);
  }
  throw new Error("CDP not ready");
}

const ws = new WebSocket(await wsUrl());
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
async function evaluate(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description || ""));
  return r.result.value;
}

await send("Page.enable");
await send("Runtime.enable");
await send("Page.navigate", { url: `${BASE}/` });
await sleep(1800);

const bytes = await readFile(FIXTURE);
await evaluate(`(async () => {
  const bin = atob("${bytes.toString("base64")}");
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
  const dt = new DataTransfer();
  dt.items.add(new File([arr], 'sample.jpg', { type: 'image/jpeg' }));
  const input = document.getElementById('fileInput');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
await sleep(1500);

// clear focal/aperture/shutter/iso so the right block holds only [logo][divider]
await evaluate(`(() => {
  for (const k of ['focal','aperture','shutter','iso']) {
    const n = document.getElementById('f-' + k);
    if (n) { n.value = ''; n.dispatchEvent(new Event('input', { bubbles: true })); }
  }
})()`);
await sleep(400);
await evaluate(`document.getElementById('brandBtn').click()`);
await sleep(300);

const rows = await evaluate(`(async () => {
  const preview = document.getElementById('preview');
  const ratio = Number(document.getElementById('s-barRatio').value);
  const opts = [...document.querySelectorAll('#brandList .opt')].slice(1);
  const out = [];
  for (const btn of opts) {
    const name = btn.querySelector('.oname').textContent.trim();
    btn.click();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const c = preview;
    const barH = Math.max(1, Math.round(c.width * ratio));
    const y0 = c.height - barH;
    const img = c.getContext('2d').getImageData(0, y0, c.width, barH).data;

    // column occupancy on the right half only (model text lives on the left)
    const colInk = new Array(c.width).fill(0);
    for (let x = Math.floor(c.width * 0.42); x < c.width; x += 1) {
      let n = 0;
      for (let y = 0; y < barH; y += 1) {
        const i = (y * c.width + x) * 4;
        if (img[i] < 235 || img[i + 1] < 235 || img[i + 2] < 235) n += 1;
      }
      colInk[x] = n;
    }
    // contiguous ink runs -> the widest one is the logo, narrow ones are the divider
    const runs = [];
    let cur = null;
    for (let x = Math.floor(c.width * 0.42); x < c.width; x += 1) {
      if (colInk[x] > 0) {
        if (!cur) cur = { x0: x, x1: x };
        else cur.x1 = x;
      } else if (cur) { runs.push(cur); cur = null; }
    }
    if (cur) runs.push(cur);
    // Letter gaps split the projection into several runs, so measure the union of
    // every run that is wider than the hairline divider (~1px at this scale).
    const solid = runs.filter((r) => r.x1 - r.x0 + 1 > 3);
    let h = 0, w = 0;
    if (solid.length) {
      const x0 = Math.min(...solid.map((r) => r.x0));
      const x1 = Math.max(...solid.map((r) => r.x1));
      w = x1 - x0 + 1;
      let top = barH, bot = -1;
      for (const run of solid) {
        for (let x = run.x0; x <= run.x1; x += 1) {
          for (let y = 0; y < barH; y += 1) {
            const i = (y * c.width + x) * 4;
            if (img[i] < 235 || img[i + 1] < 235 || img[i + 2] < 235) {
              if (y < top) top = y;
              if (y > bot) bot = y;
            }
          }
        }
      }
      h = bot - top + 1;
    }
    out.push({ name, barH, w, h, ratio: +(h / (barH / 3)).toFixed(3) });
  }
  return out;
})()`);

console.log("\nbar height:", rows[0].barH, "px   target mark height:", (rows[0].barH / 3).toFixed(1), "px\n");
console.log("brand".padEnd(14) + "width".padEnd(8) + "height".padEnd(8) + "h/(barH/3)");
console.log("-".repeat(52));
for (const r of rows) {
  const flag = r.ratio < 0.92 ? "  <-- shrunk (too wide for the cap)" : "";
  console.log(r.name.padEnd(14) + String(r.w).padEnd(8) + String(r.h).padEnd(8) + r.ratio.toFixed(2) + flag);
}
const off = rows.filter((r) => r.ratio < 0.92);
console.log(`\n${rows.length - off.length}/${rows.length} marks land on the 1/3 rule; ${off.length} capped by width.`);

ws.close();
browser.kill();
process.exit(0);
