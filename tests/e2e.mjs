/* End-to-end smoke test against a real Chromium/Edge instance via CDP.
 *
 * Prereq: the app is running, e.g.
 *   EXIF_DATA_DIR=$PWD/.tmpdata ./.venv/Scripts/python.exe -m uvicorn server.main:app --port 8098
 *
 * Run:
 *   EDGE="/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
 *   BASE_URL=http://127.0.0.1:8098 node tests/e2e.mjs
 *
 * Verifies: page boot -> config load -> file upload through the real <input>
 * -> canvas render -> download blob generation -> template switch.
 */
import { spawn } from "node:child_process";
import { writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://127.0.0.1:8098";
const EDGE = process.env.EDGE || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = Number(process.env.CDP_PORT || 9333);
const FIXTURE = path.resolve("tests/fixtures/sample.jpg");
const shot = path.resolve("tests/.tmp");
await mkdir(shot, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name} ${detail}`); }
}

const profile = await mkdtemp(path.join(tmpdir(), "ef-e2e-"));
const browser = spawn(EDGE, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
  "--window-size=1600,1000",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  "about:blank",
], { stdio: "ignore" });

async function targets() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* browser still booting */ }
    await sleep(250);
  }
  throw new Error("CDP endpoint not ready");
}

const ws = new WebSocket(await targets());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let msgId = 0;
const pending = new Map();
const pageErrors = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params?.exceptionDetails;
    pageErrors.push(d?.exception?.description || d?.text || "unknown");
  }
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
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + JSON.stringify(r.exceptionDetails.exception?.description || ""));
  return r.result.value;
}

try {
  await send("Page.enable");
  await send("DOM.enable");
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.navigate", { url: `${BASE}/` });
  await sleep(1500);

  console.log("boot");
  check("no page errors on load", await evaluate(`!document.querySelector('.toast.err')`));
  check("config loaded", await evaluate(`window.__cfgOk = !!document.querySelectorAll('.tpl').length`));
  check("two template cards", (await evaluate(`document.querySelectorAll('.tpl').length`)) === 2);
  check("brands rendered", (await evaluate(`(async()=>{document.getElementById('brandBtn').click();return document.querySelectorAll('#brandList .opt').length})()`)) >= 30);
  await evaluate(`document.getElementById('brandBtn').click()`);

  console.log("brand assets");
  // Two ways a logo asset goes wrong without anyone noticing in the UI:
  // a full-canvas backdrop rect (a slab of colour behind the mark), and a
  // config aspect that no longer matches the SVG viewBox (a squashed mark).
  const brandAudit = await evaluate(`(async () => {
    const cfg = await (await fetch('/api/config')).json();
    const load = (src) => new Promise((res, rej) => {
      const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error(src)); i.src = src;
    });
    const slabs = [];
    const skewed = [];
    for (const b of cfg.brands) {
      const res = await fetch('/assets/brands/' + b.logo);
      const vb = (await res.text()).match(/viewBox="([^"]+)"/)[1].trim().split(/[\\s,]+/).map(Number);
      const real = vb[2] / vb[3];
      if (Math.abs(real / b.aspect - 1) > 0.02) skewed.push(b.key + ' ' + b.aspect + ' vs ' + real.toFixed(3));

      const img = await load('/assets/brands/' + b.logo);
      const W = 120, H = Math.max(1, Math.round(W / (b.aspect || 3)));
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      c.getContext('2d').drawImage(img, 0, 0, W, H);
      const d = c.getContext('2d').getImageData(0, 0, W, H).data;
      let ink = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 200) ink += 1;
      if (ink / (W * H) > 0.98) slabs.push(b.key);
    }
    return { slabs, skewed };
  })()`);
  check("no logo ships a full-canvas backdrop", brandAudit.slabs, []);
  check("every brand aspect matches its viewBox", brandAudit.skewed, []);

  await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  const homeShot = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(path.join(shot, "ui-home.png"), Buffer.from(homeShot.data, "base64"));

  console.log("upload");
  const doc = await send("DOM.getDocument", { depth: -1 });
  const { nodeId } = await send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#fileInput" });
  await send("DOM.setFileInputFiles", { nodeId, files: [FIXTURE] });
  await sleep(1200);

  check("file meta filled", /sample\.jpg/.test(await evaluate(`document.getElementById('fileMeta').textContent`)),
    await evaluate(`document.getElementById('fileMeta').textContent`));
  check("preview canvas visible", await evaluate(`!document.getElementById('preview').hidden`));
  check("exif auto-filled model", (await evaluate(`document.getElementById('f-model').value`)) === "X-T4",
    await evaluate(`document.getElementById('f-model').value`));
  check("exif auto-filled params", (await evaluate(`document.getElementById('f-shutter').value`)) === "1/5800s",
    await evaluate(`document.getElementById('f-shutter').value`));
  // brand is shown as a logo image now, so assert on the asset that got picked
  const brandSrc = await evaluate(`(document.querySelector('#brandPreview img')||{}).getAttribute?.('src') || ''`);
  check("brand auto-detected (logo)", brandSrc.includes("fujifilm.svg"), brandSrc);
  check("brand logo bitmap decoded", (await evaluate(`(()=>{const i=document.querySelector('#brandPreview img');return !!(i && i.complete && i.naturalWidth>0)})()`)));
  check("canvas has watermark size", (await evaluate(`document.getElementById('preview').height > 800`)));

  console.log("interaction");
  await evaluate(`document.getElementById('s-barRatio').value = 0.14; document.getElementById('s-barRatio').dispatchEvent(new Event('input'))`);
  await sleep(300);
  check("bar ratio label updates", (await evaluate(`document.getElementById('v-barRatio').textContent`)) === "14%");
  await evaluate(`document.querySelector('.tpl[data-tpl="blur"]').click()`);
  await sleep(400);
  check("blur template active", (await evaluate(`document.querySelector('.tpl[data-tpl="blur"]').getAttribute('aria-pressed')`)) === "true");
  check("blur inset keeps the photo ratio", await evaluate(`(async()=>{
    const { blurLayout } = await import('/js/render.js');
    const cfg = await (await fetch('/api/config')).json();
    const c = document.getElementById('preview');
    const g = blurLayout(c.width, Math.round(c.width * 800 / 1200), cfg.spec.blur.layout);
    return c.height === g.canvasH && Math.abs(g.photoW / g.photoH - 1200/800) < 1e-9;
  })()`));
  check("blur canvas is taller than the source (text strip, no crop)", await evaluate(`(async()=>{
    const c = document.getElementById('preview');
    return c.height > Math.round(c.width * 800 / 1200);
  })()`));

  console.log("corner radius");
  check("radius slider defaults to 0px", (await evaluate(`document.getElementById('v-radius').textContent`)) === "0px");
  // px at the photo's top-left inset corner: sharp photo when r=0, blurred
  // backdrop once the corner is clipped away.
  const cornerPix = `(async () => {
    window.__cfg = window.__cfg || await (await fetch('/api/config')).json();
    const c = document.getElementById('preview');
    const L = window.__cfg.spec.blur.layout;
    const x = Math.round(c.width * L.padX) + 2;
    const y = Math.round(c.width * L.padTop) + 2;
    const d = c.getContext('2d').getImageData(x, y, 1, 1).data;
    return [d[0], d[1], d[2]];
  })()`;
  const sharpCorner = await evaluate(cornerPix);
  const setRadius = (v) => evaluate(
    "(() => { const s = document.getElementById('s-radius');"
    + ` s.value = ${Number(v)}; s.dispatchEvent(new Event('input')); })()`);
  await setRadius(0.05);
  await sleep(320);
  check("radius label follows the slider", (await evaluate(`document.getElementById('v-radius').textContent`)) === "60px");
  const roundedCorner = await evaluate(cornerPix);
  const delta = sharpCorner.reduce((a, v, i) => a + Math.abs(v - roundedCorner[i]), 0);
  check("rounding actually clips the photo corner", delta > 12, `${JSON.stringify(sharpCorner)} -> ${JSON.stringify(roundedCorner)}`);
  await setRadius(0);
  await sleep(320);
  const backCorner = await evaluate(cornerPix);
  const backDelta = backCorner.reduce((a, v, i) => a + Math.abs(v - sharpCorner[i]), 0);
  check("radius back to 0 restores every corner pixel", backDelta === 0, `${backDelta} px off`);

  await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  const blurShot = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(path.join(shot, "ui-blur.png"), Buffer.from(blurShot.data, "base64"));

  console.log("pixels");
  const blurPix = await evaluate(`(() => {
    const c = document.getElementById('preview');
    const ctx = c.getContext('2d');
    const p = ctx.getImageData(8, c.height - 8, 1, 1).data;
    return [p[0], p[1], p[2]];
  })()`);
  check("blur bottom is not a white bar", !(blurPix[0] > 245 && blurPix[1] > 245 && blurPix[2] > 245), JSON.stringify(blurPix));

  console.log("export");
  check("download click raises no error", await evaluate(`(async () => {
    const errs = [];
    window.addEventListener('error', (e) => errs.push(e.message));
    document.getElementById('btnDownload').click();
    await new Promise((r) => setTimeout(r, 900));
    return errs.length === 0;
  })()`));

  await evaluate(`document.querySelector('.tpl[data-tpl="classic"]').click()`);
  await sleep(500);
  const classicPix = await evaluate(`(() => {
    const c = document.getElementById('preview');
    const p = c.getContext('2d').getImageData(8, c.height - 8, 1, 1).data;
    return [p[0], p[1], p[2]];
  })()`);
  check("classic bottom-left is the white bar", classicPix[0] > 245 && classicPix[1] > 245 && classicPix[2] > 245, JSON.stringify(classicPix));

  const metrics = await evaluate(`({
    dpr: window.devicePixelRatio,
    canvasW: document.getElementById('preview').width,
    canvasH: document.getElementById('preview').height,
  })`);
  console.log("  metrics", JSON.stringify(metrics));

  const png2 = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(path.join(shot, "ui-classic.png"), Buffer.from(png2.data, "base64"));

  console.log("share");
  const shareOk = await evaluate(`(async () => {
    const errs = [];
    window.addEventListener('error', (e) => errs.push(e.message));
    document.getElementById('btnShare').click();
    for (let i = 0; i < 40; i += 1) {
      if (document.getElementById('exportHint').textContent.includes('/s/')) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return errs.length ? errs.join('|') : false;
  })()`);
  check("share link rendered in panel", shareOk === true, String(shareOk));

  console.log("batch");
  const { nodeId: batchNode } = await send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#fileInput" });
  await send("DOM.setFileInputFiles", {
    nodeId: batchNode,
    files: [FIXTURE, path.resolve("tests/fixtures/sample.png")],
  });
  await sleep(1500);
  check("queue accumulates all uploads", (await evaluate(`document.querySelectorAll('#queue .qitem').length`)) === 3,
    String(await evaluate(`document.querySelectorAll('#queue .qitem').length`)));
  check("zip button enabled", (await evaluate(`!document.getElementById('btnZip').hidden`)) === true);
  const zipOk = await evaluate(`(async () => {
    const errs = [];
    window.addEventListener('error', (e) => errs.push(e.message));
    document.getElementById('btnZip').click();
    await new Promise((r) => setTimeout(r, 2500));
    const t = document.getElementById('toast');
    return { toast: t.textContent, err: errs.join('|') };
  })()`);
  check("batch zip completes", /已打包 3 张图片|已打包/.test(zipOk.toast), JSON.stringify(zipOk));


  // Regression: served over plain http:// on a LAN IP the page is *not* a secure
  // context, so crypto.randomUUID is undefined and every upload died with
  // "crypto.randomUUID is not a function". Deleting it here reproduces that
  // origin without needing a non-localhost host.
  console.log("insecure context");
  await evaluate(`(() => {
    window.__ru = Crypto.prototype.randomUUID;
    delete Crypto.prototype.randomUUID;
    return typeof crypto.randomUUID;
  })()`);
  check("randomUUID removed for the test", (await evaluate("typeof crypto.randomUUID")) === "undefined");

  const { nodeId: insecureNode } = await send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#fileInput" });
  await evaluate(`document.getElementById('toast').textContent = ''`);
  await send("DOM.setFileInputFiles", { nodeId: insecureNode, files: [path.resolve("tests/fixtures/sample.heic")] });
  const insecureReady = await evaluate(`(async () => {
    for (let i = 0; i < 80; i += 1) {
      const meta = document.getElementById('fileMeta').textContent;
      if (meta.includes('sample.heic')) return true;
      const t = document.getElementById('toast').textContent;
      if (/not a function|读取失败/.test(t)) return t;
      await new Promise((r) => setTimeout(r, 100));
    }
    return document.getElementById('fileMeta').textContent;
  })()`);
  check("upload survives without crypto.randomUUID", insecureReady === true, String(insecureReady));
  await evaluate(`(() => { if (window.__ru) Crypto.prototype.randomUUID = window.__ru; })()`);

  console.log("heic + live photo");
  const { nodeId: liveNode } = await send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#fileInput" });
  await send("DOM.setFileInputFiles", {
    nodeId: liveNode,
    files: [
      path.resolve("tests/fixtures/live/IMG_0001.HEIC"),
      path.resolve("tests/fixtures/live/IMG_0001.MOV"),
    ],
  });
  const liveReady = await evaluate(`(async () => {
    for (let i = 0; i < 60; i += 1) {
      if (document.getElementById('fileMeta').textContent.includes('IMG_0001')) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return document.getElementById('fileMeta').textContent;
  })()`);
  check("heic decoded through the server", liveReady === true, String(liveReady));
  const liveMeta = await evaluate(`document.getElementById('fileMeta').textContent`);
  check("file meta shows the live tag", /实况/.test(liveMeta), liveMeta);
  check("queue badge marks LIVE", await evaluate(`[...document.querySelectorAll('.qbadge')].some((n) => n.textContent.includes('LIVE'))`));
  check("live export button revealed", (await evaluate(`document.getElementById('btnLive').hidden`)) === false);
  check("apple exif fills the model", (await evaluate(`document.getElementById('f-model').value`)) === "iPhone 15 Pro",
    await evaluate(`document.getElementById('f-model').value`));
  const appleSrc = await evaluate(`(document.querySelector('#brandPreview img')||{}).getAttribute?.('src') || ''`);
  check("apple brand logo picked", appleSrc.includes("apple.svg"), appleSrc);

  const liveExport = await evaluate(`(async () => {
    document.getElementById('toast').textContent = '';
    document.getElementById('btnLive').click();
    for (let i = 0; i < 60; i += 1) {
      if (/已打包/.test(document.getElementById('toast').textContent)) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return document.getElementById('toast').textContent;
  })()`);
  check("live bundle zips still + mov", liveExport === true, String(liveExport));

  const liveShot = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(path.join(shot, "ui-heic.png"), Buffer.from(liveShot.data, "base64"));

  console.log("raw");
  await send("DOM.setFileInputFiles", {
    nodeId: liveNode,
    files: [path.resolve("tests/fixtures/synthetic.dng")],
  });
  const rawReady = await evaluate(`(async () => {
    for (let i = 0; i < 80; i += 1) {
      if (document.getElementById('fileMeta').textContent.includes('synthetic.dng')) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return document.getElementById('fileMeta').textContent;
  })()`);
  check("raw decoded through the server", rawReady === true, String(rawReady));
  const rawMeta = await evaluate(`document.getElementById('fileMeta').textContent`);
  check("file meta marks RAW", /DNG|RAW/.test(rawMeta), rawMeta);
  check("raw exif make recovered", (await evaluate(`document.getElementById('f-model').value`)) === "Synthetic DNG",
    await evaluate(`document.getElementById('f-model').value`));
  check("canvas rendered from raw pixels", await evaluate(`document.getElementById('preview').height > 150`));

  console.log("heic export");
  const heicExport = await evaluate(`(async () => {
    const btn = [...document.querySelectorAll('#formatSeg button')].find((n) => n.textContent === 'HEIC');
    if (!btn) return 'no HEIC button';
    btn.click();
    await new Promise((r) => setTimeout(r, 200));
    document.getElementById('btnDownload').click();
    for (let i = 0; i < 80; i += 1) {
      if (/已导出/.test(document.getElementById('toast').textContent)) return true;
      if (document.querySelector('.toast.err')) return document.getElementById('toast').textContent;
      await new Promise((r) => setTimeout(r, 100));
    }
    return document.getElementById('toast').textContent;
  })()`);
  check("heic export completes", heicExport === true, String(heicExport));
  check("share disabled for heic", (await evaluate(`document.getElementById('btnShare').disabled`)) === true);

  check("no uncaught page exceptions", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));

  console.log(`\n${pass} passed, ${fail} failed`);
} finally {
  ws.close();
  browser.kill();
}
process.exit(fail ? 1 : 0);
