/* =============================================================================
 * tools/normalize-logos.mjs — make every brand mark optically the same size.
 *
 * Why: each vendor SVG ships with its own amount of baked-in whitespace around
 * the artwork. Scaling by viewBox height therefore renders the same nominal
 * height at wildly different *visual* heights. This tool trims every file to its
 * ink bounding box, so `height` in the renderer means "tallest ink pixel".
 *
 * It then rewrites the canvas to a single common height (UNIFORM_H) with a 2%
 * safety pad, so the files themselves are interchangeable: same height, same
 * units, aspect preserved. Without the pad, marks whose ink touches x=0 (DJI)
 * lose their outermost pixel to the canvas edge at every size.
 *
 * It also removes full-canvas white backdrop shapes (Nikon, ZTE, ...) — those
 * paint a white slab on the dark/blur template — and any artwork listed in
 * DROP_BELOW (GoPro's four leftover bars).
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

/** Every mark ends up exactly this tall in its own user units. */
const UNIFORM_H = 200;
/** Ink padding, as a fraction of the ink height, on all four sides. */
const PAD = 0.02;
/**
 * Leftover artwork to drop, by geometry rather than by element order: any
 * top-level shape whose top edge sits below `ratio × canvas height` goes.
 *
 * GoPro's export carries four solid bars underneath the wordmark — they are
 * not part of the logo, and at watermark size they read as a black blocky
 * underline. Nothing else is listed: the full-canvas plates on Nikon / realme /
 * Xiaomi are the marks themselves.
 */
const DROP_BELOW = { "gopro.svg": 0.5 };

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

  window.__norm = (items, cfg) => items.map(({ file, svg }) => {
    host.innerHTML = svg;
    const root = host.querySelector("svg");
    if (!root) return { file, error: "no <svg>" };

    const vbAttr = (root.getAttribute("viewBox") || "").trim();
    const vb = vbAttr.split(/[\s,]+/).map(Number);
    if (vb.length !== 4 || !vb.every(Number.isFinite)) return { file, error: "bad viewBox" };
    const [, , vbW, vbH] = vb;

    // ---- 0) unwrap a previous run, so the tool is idempotent
    const prev = root.querySelector(":scope > g[data-fit]");
    if (prev) {
      while (prev.firstChild) root.insertBefore(prev.firstChild, prev);
      prev.remove();
    }

    const removed = [];

    // ---- 1) drop leftover artwork that sits in its own band below the mark
    const dropBelow = cfg.dropBelow[file];
    if (dropBelow != null) {
      for (const el of Array.from(root.querySelectorAll("path,rect,polygon,circle,ellipse"))) {
        if (!topLevel(el)) continue;
        let bb0;
        try { bb0 = el.getBBox(); } catch { continue; }
        if (bb0.y >= vbH * dropBelow) {
          removed.push("stray-" + el.tagName.toLowerCase());
          el.remove();
        }
      }
    }

    // ---- 2) drop white shapes that cover (almost) the whole canvas
    // Only white/blank slabs are removed. A *coloured* full-canvas backdrop
    // has to be judged by a human: for most brands it is a bug, but Nikon's
    // yellow tile, realme's yellow plate and Xiaomi's orange squircle ARE the
    // logo. tests/e2e.mjs guards the result with a pixel-coverage check.
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

    // ---- 3) uniform canvas: scale the trimmed ink to a common height, keep
    // its aspect, and leave a 2% pad so the outermost ink is never shaved by
    // the canvas edge (DJI's letters start at x=0.02).
    const padPx = bb.height * cfg.pad;
    const k = cfg.uniformH / (bb.height + padPx * 2);
    const box = document.createElementNS(root.namespaceURI, "g");
    box.setAttribute("data-fit", "1");
    box.setAttribute("transform",
      "scale(" + (+k.toFixed(6)) + ") translate("
      + (+(-(bb.x - padPx)).toFixed(4)) + " " + (+(-(bb.y - padPx)).toFixed(4)) + ")");
    while (root.firstChild) box.appendChild(root.firstChild);
    root.appendChild(box);

    const outW = (bb.width + padPx * 2) * k;
    root.setAttribute("viewBox", "0 0 " + (+outW.toFixed(4)) + " " + cfg.uniformH);
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
      aspect: +(outW / cfg.uniformH).toFixed(4),
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
    expression: `window.__norm(${JSON.stringify(items)}, ${JSON.stringify({
      dropBelow: DROP_BELOW, uniformH: UNIFORM_H, pad: PAD,
    })})`,
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
