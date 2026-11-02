/**
 * Regenerate the documentation screenshots in docs/assets/.
 *
 * GitHub renders README images at ~900px wide, so capturing at 2x and
 * downscaling to 1440 leaves the UI text crisp without shipping a 3MB PNG.
 *
 *   node tools/doc-screenshots.mjs            # writes docs/assets/*.png
 *   BASE_URL=http://127.0.0.1:8099 node tools/doc-screenshots.mjs
 *
 * Needs a running server (any port) and Edge/Chrome. Nothing here is
 * brand-specific: the demo photo is tests/fixtures/sample.jpg, a synthetic
 * 1200x800 frame with ordinary iPhone EXIF, so no personal photo ever ends
 * up in the repo.
 */
import { spawn } from "node:child_process";
import { writeFile, mkdir, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://127.0.0.1:8099";
const EDGE = process.env.EDGE || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const OUT = "docs/assets";
const VIEW = { width: 1440, height: 1330 };
const DSF = 2;
const FINAL_W = 1440;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = promisify(execFile);

const PORT = 9361;
const browser = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-first-run",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(process.env.TEMP || "/tmp", "docshot-" + Date.now())}`,
  "about:blank"], { stdio: "ignore" });

async function target() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* still booting */ }
    await sleep(250);
  }
  throw new Error("could not reach the browser over CDP");
}

const ws = new WebSocket(await target());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  const p = m.id && pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
};
const send = (method, params = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
};
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
};

async function shoot(file) {
  const shot = await send("Page.captureScreenshot", { format: "png" });
  const raw = Buffer.from(shot.data, "base64");
  const tmp = path.join(OUT, ".raw-" + file);
  await writeFile(tmp, raw);
  // Pillow does the downscale: Lanczos on a 2x capture keeps hairlines and
  // 12px UI text sharp, which plain 1x capture turns to mush.
  await run("python", ["-c", `
from PIL import Image
import sys
src, dst, w = sys.argv[1], sys.argv[2], int(sys.argv[3])
im = Image.open(src).convert("RGB")
h = round(im.height * w / im.width)
im.resize((w, h), Image.LANCZOS).save(dst, optimize=True)
print(dst, w, h)
`, tmp, path.join(OUT, file), String(FINAL_W)]);
  await unlink(tmp); // the 2x original is an intermediate, not an artifact
}

async function openPage(query = "") {
  await send("Page.navigate", { url: `${BASE}/${query}` });
  await sleep(1400);
}

async function uploadDemoPhoto() {
  const doc = await send("DOM.getDocument", { depth: -1, pierce: true });
  const input = await send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#fileInput" });
  await send("DOM.setFileInputFiles", {
    nodeId: input.nodeId,
    files: [path.resolve("tests/fixtures/sample.jpg")],
  });
  // The preview canvas replacing the dropzone is the signal that the pipeline
  // finished — a fixed sleep would either flake or pad every run.
  for (let i = 0; i < 60; i += 1) {
    const ready = await evaluate(`(() => {
      const c = document.getElementById('preview');
      const dz = document.getElementById('dropzone');
      return !!(c && !c.hidden && c.width > 200 && dz && dz.hidden);
    })()`);
    if (ready) break;
    await sleep(150);
  }
  await sleep(600); // let the entrance animation settle
}

async function pickTemplate(id) {
  await evaluate(`document.querySelector('.tpl[data-tpl="${id}"]').click()`);
  await sleep(700);
}

try {
  await send("Page.enable");
  await send("Runtime.enable");
  await send("DOM.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: VIEW.width, height: VIEW.height, deviceScaleFactor: DSF, mobile: false,
  });
  await mkdir(OUT, { recursive: true });

  // 1) empty state, dark — the first thing a visitor sees
  await openPage("?theme=dark");
  await shoot("screenshot-home.png");

  // 2) same page after a photo lands, classic template
  await uploadDemoPhoto();
  await pickTemplate("classic");
  await shoot("screenshot-classic.png");

  // 3) blur template
  await pickTemplate("blur");
  await shoot("screenshot-blur.png");

  // 4) light theme, classic
  await openPage("?theme=light");
  await uploadDemoPhoto();
  await pickTemplate("classic");
  await shoot("screenshot-light.png");

  console.log("done");
} finally {
  ws.close();
  browser.kill();
}
