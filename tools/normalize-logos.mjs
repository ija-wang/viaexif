/* =============================================================================
 * tools/normalize-logos.mjs — one geometry for every brand mark.
 *
 * Two things are true of vendor SVG exports and neither is true of a good
 * asset library:
 *
 *   1. Each file carries its own amount of baked-in whitespace, so the same
 *      nominal `height` renders at wildly different *visual* heights.
 *   2. Each file declares its own viewBox scale (1024, 1024x1024, 6655x1021,
 *      ...), so nothing can be compared or swapped without arithmetic.
 *
 * This tool fixes both, in place:
 *
 *   trim  -> the viewBox becomes the ink bounding box (no dead margin)
 *   fit   -> the artwork is wrapped in <g data-fit="1"> and scaled so the ink
 *            is exactly 184 units tall inside a 200-unit-tall canvas (4% pad
 *            on every side). The pad is not decoration: at the sizes the
 *            watermark actually uses (24-40px tall) a smaller pad rounds away
 *            to nothing, the ink lands flush on the bitmap edge, and the mark
 *            looks like it has a hard outline cut into it.
 *
 * After that, `viewBox height === 200` for every file and the aspect ratio in
 * server/config.py is simply `width / 200`.
 *
 * What it removes: exactly one thing — a *white, solid, rectangular* shape that
 * covers the whole canvas. That is a backdrop, not a mark: it is invisible on
 * the light template and paints a white slab on the dark one (Lumix shipped
 * one). The test is geometric, not colour-based, because a colour-only rule
 * deleted real artwork: Nikon's white streaks live on a yellow tile and Leica
 * and Sigma put white lettering inside their marks. Those are irregular paths
 * (curves), so they never match the plate test.
 *
 * The spreadsheet stays the source of truth for what a mark contains; this tool
 * only drops the transparent-canvas-by-another-name and rescales.
 *
 * Usage:
 *   node tools/normalize-logos.mjs            # rewrite files in place
 *   node tools/normalize-logos.mjs --check    # report only, no writes
 *   node tools/normalize-logos.mjs --report   # report + full-canvas shapes
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

/* Marks whose sheet artwork carries a frame the iconfont pack baked in.
 * GoPro ships four solid squares in a strip under the wordmark — same ink as
 * the mark, pure rectangles, nothing to do with the logo. They are removed by
 * rule (not by hand) so re-importing the sheet reproduces the same file. */
const EXTRA_RECTS = new Set(["gopro.svg"]);
const REPORT = CHECK_ONLY || process.argv.includes("--report");

/* The canvas every mark is fitted into. 200 units tall, ink 184 of them. */
const H = 200;
const PAD = 8; // = 4% of H, on each side

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
  const PAD = ${PAD}, H = ${H};
  const EXTRAS = new Set(${JSON.stringify([...EXTRA_RECTS])});

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

    // Already fitted: the numbers below would compound, so leave the file
    // alone. Re-import from the sheet first when the artwork itself changes.
    if (root.querySelector('g[data-fit="1"]')) {
      const vb = (root.getAttribute("viewBox") || "").split(/[\s,]+/).map(Number);
      return { file, skipped: true, aspect: +(vb[2] / vb[3]).toFixed(4), box: { w: vb[2], h: vb[3] } };
    }

    const vbAttr = (root.getAttribute("viewBox") || "").trim();
    const vb = vbAttr.split(/[\s,]+/).map(Number);
    if (vb.length !== 4 || !vb.every(Number.isFinite)) return { file, error: "bad viewBox" };
    const [, , vbW, vbH] = vb;

    // ---- 1) drop the white backdrop slab, if there is one
    // A plate is white AND solid AND rectangular AND canvas-sized. Anything
    // that needs a curve to describe is artwork and is left alone.
    const removed = [];
    const WHITEISH = (c) => {
      const s = String(c || "").trim().toLowerCase().replace(/\s+/g, "");
      return s === "white" || s === "#fff" || s === "#ffffff" || s === "rgb(255,255,255)";
    };
    for (const el of Array.from(root.children)) {
      if (!["rect", "path", "polygon"].includes(el.tagName.toLowerCase())) continue;
      const cs = getComputedStyle(el);
      if (!WHITEISH(cs.fill) || parseFloat(cs.opacity) < 0.5) continue;
      let bb;
      try { bb = el.getBBox(); } catch { continue; }
      if (bb.width / vbW < 0.95 || bb.height / vbH < 0.95) continue;
      const tag = el.tagName.toLowerCase();
      const d = tag === "path" ? (el.getAttribute("d") || "") : "";
      const cmds = d.match(/[a-z]/gi) || [];
      const straight = tag !== "path" || (cmds.length > 0 && cmds.length <= 6 && cmds.every((c) => "mMhHvVlLzZ".includes(c)));
      if (!straight) continue;
      removed.push(tag + ":" + bb.width.toFixed(0) + "x" + bb.height.toFixed(0));
      el.remove();
    }

    // ---- 1b) drop a baked-in rectangle frame (see EXTRA_RECTS)
    if (EXTRAS.has(file)) {
      for (const el of Array.from(root.children)) {
        if (el.tagName.toLowerCase() !== "path") continue;
        const d = el.getAttribute("d") || "";
        const cmds = d.match(/[a-z]/gi) || [];
        if (!cmds.length || cmds.length > 12 || !cmds.every((c) => "mMhHvVlLzZ".includes(c))) continue;
        let bb;
        try { bb = el.getBBox(); } catch { continue; }
        if (bb.width / vbW > 0.9 && bb.height / vbH > 0.9) continue; // a plate, not a frame
        removed.push("frame:" + bb.width.toFixed(0) + "x" + bb.height.toFixed(0));
        el.remove();
      }
    }

    // ---- report only: shapes that fill the canvas (possible backdrop tiles).
    // Nothing else is removed — this exists so a human can eyeball the list.
    const tiles = [];
    for (const el of Array.from(root.querySelectorAll("rect,path,polygon,circle,ellipse"))) {
      if (!topLevel(el)) continue;
      let bb;
      try { bb = el.getBBox(); } catch { continue; }
      if (bb.width / vbW < 0.9 || bb.height / vbH < 0.9) continue;
      const cs = getComputedStyle(el);
      tiles.push(el.tagName.toLowerCase() + ":" + (cs.fill || "-") + "@" + bb.width.toFixed(0) + "x" + bb.height.toFixed(0));
    }

    // ---- ink bounding box in user space
    let bb;
    try { bb = root.getBBox(); } catch (e) { return { file, error: "getBBox: " + e.message }; }
    if (!bb || !bb.width || !bb.height) return { file, error: "empty artwork" };

    // ---- rescale: ink height -> H - 2*PAD, centred, in a H-tall canvas
    const k = (H - 2 * PAD) / bb.height;
    const W = +(bb.width * k + 2 * PAD).toFixed(3);
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("data-fit", "1");
    g.setAttribute("transform",
      "translate(" + [PAD - bb.x * k, PAD - bb.y * k].map((n) => +n.toFixed(4)).join(" ") + ") scale(" + +k.toFixed(6) + ")");
    while (root.firstChild) g.appendChild(root.firstChild);
    root.appendChild(g);

    root.setAttribute("viewBox", "0 0 " + W + " " + H);
    root.removeAttribute("width");
    root.removeAttribute("height");
    root.removeAttribute("x");
    root.removeAttribute("y");

    const out = new XMLSerializer().serializeToString(root);
    return {
      file,
      tiles,
      before: { w: vbW, h: vbH },
      box: { x: +bb.x.toFixed(3), y: +bb.y.toFixed(3), w: +bb.width.toFixed(3), h: +bb.height.toFixed(3) },
      aspect: +(W / H).toFixed(4),
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
console.log("\n" + pad("file", 18) + pad("aspect", 9) + pad("status", 9) + "note");
console.log("-".repeat(78));
let bad = 0;
for (const r of results) {
  if (r.error) { bad += 1; console.log(pad(r.file, 18) + "ERROR   " + r.error); continue; }
  const parts = [];
  if (r.removed?.length) parts.push("white plate dropped: " + r.removed.join(","));
  if (REPORT && r.tiles?.length) parts.push("canvas-filling: " + r.tiles.join(","));
  const note = r.skipped ? "already fitted" : parts.join(" | ");
  console.log(pad(r.file, 18) + pad(r.aspect, 9) + pad(r.skipped ? "skip" : "fit", 9) + note);
}

if (!CHECK_ONLY) {
  for (const r of results) {
    if (r.error || r.skipped) continue;
    await writeFile(path.join(BRANDS_DIR, r.file), r.svg + "\n", "utf8");
  }
  console.log(`\nfitted ${results.filter((r) => !r.error && !r.skipped).length}/${files.length} files`);
}
if (bad) console.log(`\n${bad} file(s) failed`);

console.log("\n# aspect values for server/config.py BRANDS");
for (const r of results) {
  if (r.error) continue;
  console.log(`  ${r.file.replace(/\.svg$/, "").padEnd(12)} ${r.aspect}`);
}

ws.close();
browser.kill();
process.exit(0);
