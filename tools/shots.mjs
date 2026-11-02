/* =============================================================================
 * tools/shots.mjs — render every brand through the real UI and stitch the
 * watermark bars into one contact sheet, so logo sizing can be reviewed at a
 * glance (and compared against docs/assets/logo-sheet.png).
 *
 * Prereq: app running (see README), then:
 *   EDGE=... BASE_URL=http://127.0.0.1:8098 node tools/shots.mjs
 * ========================================================================== */
import { spawn } from "node:child_process";
import { writeFile, readFile, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://127.0.0.1:8098";
const EDGE = process.env.EDGE || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = Number(process.env.CDP_PORT || 9352);
const FIXTURE = path.resolve("tests/fixtures/sample.jpg");
const OUT_DIR = path.resolve("tests/.tmp");
await mkdir(OUT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = await mkdtemp(path.join(tmpdir(), "vx-shots-"));
const browser = spawn(EDGE, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
  "--window-size=1600,1100",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  "about:blank",
], { stdio: "ignore" });

async function target() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const page = (await res.json()).find((t) => t.type === "page");
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
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
};
function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function evaluate(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description || ""));
  return r.result.value;
}

await send("Page.enable");
await send("DOM.enable");
await send("Runtime.enable");
await send("Page.navigate", { url: `${BASE}/` });
await sleep(1800);

// Feed the fixture through a real DataTransfer + change event; DOM.setFileInputFiles
// is flaky when the config-driven UI is still rebuilding nodes.
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
  return input.files.length;
})()`);
await sleep(1600);

/* ---- contact sheet: one row per brand, bar cropped and scaled */
async function sheet(template) {
  await evaluate(`document.querySelector('.tpl[data-tpl="${template}"]').click()`);
  await sleep(400);
  await evaluate(`document.getElementById('brandBtn').click()`);
  await sleep(300);

  return evaluate(`(async () => {
    const preview = document.getElementById('preview');
    const tplName = ${JSON.stringify(template)};
    const ratio = Number(document.getElementById('s-barRatio').value);
    const opts = [...document.querySelectorAll('#brandList .opt')];
    const rows = [];

    for (const btn of opts) {
      const name = btn.querySelector('.oname').textContent.trim();
      btn.click();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const c = preview;
      const barH = Math.max(1, Math.round(c.width * (tplName === 'blur' ? 0.12 : ratio)));
      // snapshot the bar NOW — the preview canvas is reused for every brand
      const snap = document.createElement('canvas');
      snap.width = c.width;
      snap.height = barH;
      snap.getContext('2d').drawImage(c, 0, c.height - barH, c.width, barH, 0, 0, c.width, barH);
      const shown = (document.querySelector('#brandPreview img') || {}).getAttribute
        ? document.querySelector('#brandPreview img').getAttribute('src') : '';
      rows.push({ name, src: snap, srcY: 0, barH, cw: c.width, shown });
    }

    const OUT_W = 980;
    const PAD_L = 130;
    const rowH = Math.round((OUT_W - PAD_L) * ratio);
    const out = document.createElement('canvas');
    out.width = OUT_W;
    out.height = rowH * rows.length;
    const g = out.getContext('2d');
    g.fillStyle = '#0d0f12';
    g.fillRect(0, 0, out.width, out.height);
    g.imageSmoothingQuality = 'high';

    rows.forEach((r, i) => {
      const y = i * rowH;
      g.drawImage(r.src, 0, r.srcY, r.cw, r.barH, PAD_L, y, OUT_W - PAD_L, rowH);
      g.fillStyle = '#9ca3af';
      g.font = '13px -apple-system,"Segoe UI",sans-serif';
      g.textBaseline = 'middle';
      g.fillText(r.name.slice(0, 16), 10, y + rowH / 2);
      g.fillStyle = '#1f242b';
      g.fillRect(0, y + rowH - 1, OUT_W, 1);
    });

    return { dataUrl: out.toDataURL('image/png'), rows: rows.length, rowH, barH: rows[0]?.barH, cw: rows[0]?.cw, shown: rows.map((r) => r.name + '=' + (r.shown || '').split('/').pop()) };
  })()`);
}

for (const tpl of ["classic", "blur"]) {
  const shot = await sheet(tpl);
  const b64 = shot.dataUrl.split(",")[1];
  await writeFile(path.join(OUT_DIR, `sheet-${tpl}.png`), Buffer.from(b64, "base64"));
  console.log(tpl, "rows", shot.rows, "barH", shot.barH, "canvasW", shot.cw,
    "=> markH", (shot.barH * 0.3333).toFixed(1));
  console.log("  pick:", shot.shown.join(" "));
}

ws.close();
browser.kill();
process.exit(0);
