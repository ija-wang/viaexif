/* =============================================================================
 * tools/normalize-logos.mjs — make every brand mark optically the same size.
 *
 * Why: each vendor SVG ships with its own amount of baked-in whitespace around
 * the artwork. Scaling by viewBox height therefore renders the same nominal
 * height at wildly different *visual* heights. This tool trims every file to its
 * ink bounding box, so `height` in the renderer means "tallest ink pixel".
 *
 * It also removes full-canvas white backdrop shapes (Nikon, ZTE, ...) — those
 * paint a white slab on the dark/blur template.
 *
 * Usage:
 *   node tools/normalize-logos.mjs            # rewrite files in place
 *   node tools/normalize-logos.mjs --check    # report only, no writes
 * ========================================================================== */
import { spawn } from "node:child_process";
import { readFile, writeFile, readdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const BRANDS_DIR = path.join(ROOT, "web/assets/brands");
const EDGE = process.env.EDGE || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = Number(process.env.CDP_PORT || 9351);
const CHECK_ONLY = process.argv.includes("--check");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ browser */
const profile = await mkdtemp(path.join(tmpdir(), "vx-logo-"));
const browser = spawn(EDGE, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--hide-scrollbars",
  "--window-size=1200,800",
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
    } catch { /* still booting */ }
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
  msgId += 1;
  const id = msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

await send("Runtime.enable");

/* ---------------------------------------------------- in-page normalisation */
const PAGE_JS = String.raw`
(() => {
  const host = document.getElementById("__host");
  const WHITEISH = (c) => {
    if (!c) return false;
    const s = String(c).trim().toLowerCase().replace(/\s+/g, "");
    if (s === "white") return true;
    if (s === "#fff" || s === "#ffffff") return true;
    if (s === "rgb(255,255,255)") return true;
    const m = s.match(/^rgba?\((\d+),(\d+),(\d+)(?:,([\d.]+))?\)$/);
    if (m) return +m[1] === 255 && +m[2] === 255 && +m[3] === 255 && (m[4] === undefined || +m[4] > 0.5);
    return false;
  };

  function topLevel(el) {
    let n = el;
    while (n.parentElement && n.parentElement.tagName.toLowerCase() !== "svg") {
      n = n.parentElement;
      if (n.tagName.toLowerCase() !== "g") return null;
    }
    return n;
  }

  window.__norm = (items) => items.map(({ file, svg }) => {
    host.innerHTML = svg;
    const root = host.querySelector("svg");
    if (!root) return { file, error: "no <svg>" };

    const vbAttr = (root.getAttribute("viewBox") || "").trim();
    const vb = vbAttr.split(/[\s,]+/).map(Number);
    if (vb.length !== 4 || !vb.every(Number.isFinite)) return { file, error: "bad viewBox" };
    const [, , vbW, vbH] = vb;

    // ---- 1) drop white shapes that cover (almost) the whole canvas
    // Only white/blank slabs are removed. A *coloured* full-canvas backdrop
    // has to be judged by a human: for most brands it is a bug (Nikon and
    // realme both shipped a yellow slab that painted a block behind the mark),
    // but Xiaomi's orange squircle is the real logo. tests/e2e.mjs guards the
    // result with a pixel-coverage check, which is the only reliable test —
    // bounding boxes are useless once the viewBox has been trimmed to the ink.
    const removed = [];
    for (const el of Array.from(root.querySelectorAll("rect,path,polygon,circle,ellipse"))) {
      if (!topLevel(el)) continue;
      const cs = getComputedStyle(el);
      const invisible = cs.fill === "none" && (cs.stroke === "none" || !cs.stroke);
      if (!WHITEISH(cs.fill) && !invisible) continue;
      if (parseFloat(cs.opacity) < 0.5) continue;
      let bb;
      try { bb = el.getBBox(); } catch { continue; }
      const cover = (bb.width * bb.height) / (vbW * vbH || 1);
      if (cover < 0.95) continue;
      removed.push((invisible ? "blank-" : "white-") + el.tagName.toLowerCase() + ":" + (bb.width.toFixed(1) + "x" + bb.height.toFixed(1)));
      el.remove();
    }

    // ---- 2) ink bounding box in user space
    let bb;
    try { bb = root.getBBox(); } catch (e) { return { file, error: "getBBox: " + e.message }; }
    if (!bb || !bb.width || !bb.height) return { file, error: "empty artwork", removed };

    // ---- 3) rewrite viewBox tightly, drop fixed pixel size
    root.setAttribute("viewBox", [bb.x, bb.y, bb.width, bb.height]
      .map((n) => +n.toFixed(4)).join(" "));
    root.removeAttribute("width");
    root.removeAttribute("height");
    root.removeAttribute("x");
    root.removeAttribute("y");

    const out = new XMLSerializer().serializeToString(root);
    return {
      file,
      removed,
      before: { w: vbW, h: vbH },
      box: { x: +bb.x.toFixed(3), y: +bb.y.toFixed(3), w: +bb.width.toFixed(3), h: +bb.height.toFixed(3) },
      aspect: +(bb.width / bb.height).toFixed(4),
      svg: out,
    };
  });
  return true;
})();
`;

await send("Runtime.evaluate", {
  expression: `document.body.innerHTML='<div id="__host" style="position:absolute;left:-99999px;top:0;visibility:hidden"></div>';` + PAGE_JS,
  awaitPromise: false,
});

/* -------------------------------------------------------------------- drive */
const files = (await readdir(BRANDS_DIR)).filter((f) => f.endsWith(".svg")).sort();

async function runBatch(items) {
  const res = await send("Runtime.evaluate", {
    expression: `window.__norm(${JSON.stringify(items)})`,
    returnByValue: true,
    awaitPromise: false,
  });
  if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails));
  return res.result.value;
}

const results = [];
for (let i = 0; i < files.length; i += 6) {
  const batch = [];
  for (const f of files.slice(i, i + 6)) {
    batch.push({ file: f, svg: await readFile(path.join(BRANDS_DIR, f), "utf8") });
  }
  results.push(...(await runBatch(batch)));
}

/* ------------------------------------------------------------------- report */
const pad = (s, n) => String(s).padEnd(n);
console.log("\n" + pad("file", 18) + pad("aspect", 9) + pad("h/w%", 8) + "note");
console.log("-".repeat(64));
let bad = 0;
for (const r of results) {
  if (r.error) { bad += 1; console.log(pad(r.file, 18) + "ERROR   " + r.error); continue; }
  const fillRatio = ((r.box.h / r.before.h) * 100).toFixed(1);
  const note = r.removed.length ? "bg removed: " + r.removed.join(",") : "";
  console.log(pad(r.file, 18) + pad(r.aspect, 9) + pad(fillRatio, 8) + note);
}

if (!CHECK_ONLY) {
  for (const r of results) {
    if (r.error) continue;
    await writeFile(path.join(BRANDS_DIR, r.file), r.svg + "\n", "utf8");
  }
  console.log(`\nrewrote ${results.filter((r) => !r.error).length}/${files.length} files`);
}
if (bad) console.log(`\n${bad} file(s) failed`);

ws.close();
browser.kill();
process.exit(0);
