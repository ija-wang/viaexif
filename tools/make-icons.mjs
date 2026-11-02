/* =============================================================================
 * tools/make-icons.mjs — rasterise the app icon (web/assets/viaexif.svg) into
 * the PNG sizes a store / launcher wants.
 *
 * The master artwork is vector, but a package manifest (fnOS fpk, PWAs, an app
 * store listing) almost always asks for a bitmap at a fixed size, and nobody
 * should be hand-exporting those. Run after touching the SVG:
 *
 *   node tools/make-icons.mjs
 *
 * Output: web/assets/icons/icon-<size>.png (transparent outside the squircle).
 * ========================================================================== */
import { spawn } from "node:child_process";
import { writeFile, mkdir, readFile, readdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "web/assets/viaexif.svg");
const OUT = path.join(ROOT, "web/assets/icons");
const EDGE = process.env.EDGE || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = Number(process.env.CDP_PORT || 9363);
const SIZES = [16, 32, 48, 64, 128, 180, 192, 256, 512];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = await mkdtemp(path.join(tmpdir(), "vx-icon-"));
const browser = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-first-run", "--hide-scrollbars",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });

async function target() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* still booting */ }
    await sleep(250);
  }
  throw new Error("CDP endpoint not ready");
}

const ws = new WebSocket(await target());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
  }
};
const send = (method, params = {}) => {
  const mid = ++id;
  ws.send(JSON.stringify({ id: mid, method, params }));
  return new Promise((resolve, reject) => pending.set(mid, { resolve, reject }));
};
await send("Runtime.enable");

const svg = (await readFile(SRC, "utf8")).replace(/^<\?xml[^>]*>\s*/, "");
const dataUri = "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64");

const shots = await send("Runtime.evaluate", {
  expression: `(async () => {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('svg')); i.src = ${JSON.stringify(dataUri)}; });
    const out = [];
    for (const s of ${JSON.stringify(SIZES)}) {
      const c = document.createElement('canvas'); c.width = s; c.height = s;
      const x = c.getContext('2d');
      x.imageSmoothingQuality = 'high';
      x.drawImage(img, 0, 0, s, s);
      out.push({ s, png: c.toDataURL('image/png') });
    }
    return out;
  })()`,
  awaitPromise: true,
  returnByValue: true,
});
if (shots.exceptionDetails) throw new Error(JSON.stringify(shots.exceptionDetails));

await mkdir(OUT, { recursive: true });
for (const { s, png } of shots.result.value) {
  await writeFile(path.join(OUT, `icon-${s}.png`), Buffer.from(png.split(",")[1], "base64"));
}
console.log(`wrote ${SIZES.length} icons to web/assets/icons (${(await readdir(OUT)).length} files)`);
ws.close();
browser.kill();
