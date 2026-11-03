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

  console.log("build identity");
  // A cache that hands back the previous build is indistinguishable from a
  // failed deploy unless the page states which build it is. The chip is filled
  // from /api/config, so it names the container that answered, not the bundle.
  const build = await evaluate(`(async () => {
    const health = await (await fetch('/api/health', { cache: 'no-store' })).json();
    const html = await fetch('/', { cache: 'no-store' });
    const js = await fetch('/js/app.js', { cache: 'no-store' });
    const font = await fetch('/assets/fonts/maple-mono-nf-cn-regular.woff2', { cache: 'no-store' });
    const cfg = await (await fetch('/api/config', { cache: 'no-store' })).json();
    return {
      chip: (document.getElementById('appVersion') || {}).textContent || '',
      health: health.version,
      config: cfg.version,
      htmlCC: html.headers.get('cache-control') || '',
      jsCC: js.headers.get('cache-control') || '',
      fontCC: font.headers.get('cache-control') || '',
      served: await html.text(),
    };
  })()`);
  check("the page names the build it is running", build.chip === `v${build.config}`,
    `${build.chip} vs config ${build.config}`);
  check("that build is the one the container reports", build.config === build.health,
    `${build.config} vs health ${build.health}`);
  // The stamp has to survive a stale or broken bundle — that is exactly when it
  // is needed — so it is written into the markup by the server.
  check("the build number is in the markup, not painted by the bundle",
    build.served.includes(`v${build.config}`), `missing v${build.config}`);
  check("no placeholder leaked into the shell", !build.served.includes("__APP_VERSION__"));
  // A versioned URL is a different cache key, so an entry stored before this
  // release cannot answer for the new bundle even on a browser that still holds
  // it. Without this the shell would refresh and the JS would not.
  check("entry assets carry the build in their URL",
    build.served.includes(`./js/app.js?v=${build.config}`)
      && build.served.includes(`./css/style.css?v=${build.config}`));
  // Heuristic freshness (no Cache-Control) is what made a redeployed container
  // keep serving the old app.js: the browser never asked, so ETag never helped.
  // `no-cache` still left pre-1.2.1 entries with their invented lifetime, so the
  // shell and the bundle are now never stored at all.
  check("the shell is never stored", build.htmlCC === "no-store", build.htmlCC);
  check("the app bundle is never stored either", build.jsCC === "no-store", build.jsCC);
  // Fonts are the deliberate exception: large, build-stable, uniquely named.
  check("web fonts may be cached", /max-age=\d+/.test(build.fontCC), build.fontCC);

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
    const notUniform = [];
    const bleed = [];
    const inkHeights = [];
    for (const b of cfg.brands) {
      const res = await fetch('/assets/brands/' + b.logo);
      const vb = (await res.text()).match(/viewBox="([^"]+)"/)[1].trim().split(/[\\s,]+/).map(Number);
      const real = vb[2] / vb[3];
      if (Math.abs(real / b.aspect - 1) > 0.02) skewed.push(b.key + ' ' + b.aspect + ' vs ' + real.toFixed(3));
      // Every file is normalised to the same canvas height; the renderer keys
      // its width off the aspect, so a stray height would silently rescale.
      if (Math.abs(vb[3] - 200) > 0.01) notUniform.push(b.key + ' h=' + vb[3]);

      const img = await load('/assets/brands/' + b.logo);
      // Height-driven, like the renderer: a width-driven box makes wide marks
      // 20px tall, where the 2% pad is sub-pixel and the edge test lies.
      const H = 140, W = Math.max(1, Math.round(H * (b.aspect || 3)));
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      c.getContext('2d').drawImage(img, 0, 0, W, H);
      const d = c.getContext('2d').getImageData(0, 0, W, H).data;
      let ink = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 200) ink += 1;
      if (ink / (W * H) > 0.98) slabs.push(b.key);
      // Ink height, not canvas height: the viewBox being 200 units tall says
      // nothing about how much of it the artwork fills, and it is the artwork
      // that has to look the same size from one brand to the next.
      let top = H;
      let bottom = -1;
      for (let y = 0; y < H; y += 1) {
        for (let x = 0; x < W; x += 1) {
          if (d[(y * W + x) * 4 + 3] > 200) { if (y < top) top = y; if (y > bottom) bottom = y; break; }
        }
      }
      if (bottom > top) inkHeights.push({ key: b.key, h: bottom - top + 1 });
      // ...and the 2% pad has to survive rasterisation: ink on the outer 1px
      // ring means the mark gets shaved at every export size.
      const alphaAt = (x, y) => d[(y * W + x) * 4 + 3];
      let edge = 0;
      for (let x = 0; x < W; x += 1) edge = Math.max(edge, alphaAt(x, 0), alphaAt(x, H - 1));
      for (let y = 0; y < H; y += 1) edge = Math.max(edge, alphaAt(0, y), alphaAt(W - 1, y));
      if (edge > 60) bleed.push(b.key);
    }
    return { slabs, skewed, notUniform, bleed, inkHeights, total: cfg.brands.length,
             zeiss: cfg.brands.some((b) => b.key === "zeiss") };
  })()`);
  // A few marks *are* solid tiles by design (the Nikon and realme yellow
  // plates are the logo, not a leftover backdrop), so those are expected.
  // Anything else covering its whole box is a backdrop that slipped in.
  const SOLID = ["nikon", "realme"];
  const straySlabs = brandAudit.slabs.filter((k) => !SOLID.includes(k));
  check("no logo ships a stray full-canvas backdrop", straySlabs.length === 0, straySlabs.join(","));
  check("every brand aspect matches its viewBox", brandAudit.skewed.length === 0, brandAudit.skewed.join("; "));
  check("every brand canvas is the same height", brandAudit.notUniform.length === 0, brandAudit.notUniform.join("; "));
  check("no brand ink touches the canvas edge", brandAudit.bleed.length === 0, brandAudit.bleed.join(","));
  // "All logos are the same height" is about what the eye measures, which is the
  // ink, not the box: a 200-unit viewBox with a 4% pad that only some files got
  // would still look wrong. Measured at H=140 they must land within 2px of each
  // other — that is one anti-aliased row, i.e. no drift at all.
  const inkMin = Math.min(...brandAudit.inkHeights.map((r) => r.h));
  const inkMax = Math.max(...brandAudit.inkHeights.map((r) => r.h));
  check("every brand was measured", brandAudit.inkHeights.length === brandAudit.total,
    `${brandAudit.inkHeights.length}/${brandAudit.total}`);
  check("every brand mark has the same visual height", inkMax - inkMin <= 2,
    `${inkMin}..${inkMax}px (${brandAudit.inkHeights.filter((r) => r.h < inkMax - 2 || r.h > inkMin + 2)
      .map((r) => r.key + "=" + r.h).join(",")})`);
  check("zeiss mark is in the brand list", brandAudit.zeiss === true);

  console.log("render reuse");
  // Tinted marks go through one shared scratch canvas. It used to only *grow*
  // and clear the current mark's box, so a previous, wider mark stayed alive to
  // the right of that box — and drawImage samples bilinearly, so the last
  // destination column reached one texel into it. The preview got a 1px grey
  // rule glued to the mark; the export didn't, because at export size the clear
  // happened to cover the leftovers. Same input, same pixels, always.
  const reuse = await evaluate(`(async () => {
    const cfg = await (await fetch('/api/config')).json();
    // A fresh module instance per URL: same code, its own scratch canvas.
    const shared = await import('/js/render.js');
    const virgin = await import('/js/render.js?fresh=' + Date.now());
    const spec = cfg.spec.classic;
    const byKey = (k) => cfg.brands.find((b) => b.key === k);
    const load = (src) => new Promise((res, rej) => {
      const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error(src)); i.src = src;
    });
    const photo = document.createElement('canvas');
    photo.width = 1200; photo.height = 800;
    const pc = photo.getContext('2d');
    const g = pc.createLinearGradient(0, 0, 1200, 800);
    g.addColorStop(0, '#20313f'); g.addColorStop(1, '#8f6b4a');
    pc.fillStyle = g; pc.fillRect(0, 0, 1200, 800);

    const wide = byKey('gopro');
    const narrow = byKey('lumix');
    const wideImg = await load('/assets/brands/' + wide.logo);
    const narrowImg = await load('/assets/brands/' + narrow.logo);
    const draw = (mod, c, brand, img) => mod.render(c, photo, {
      template: 'classic', spec, brand, logoImg: img,
      fields: { model: 'X-T4', shotAt: '2024-05-16 12:33', params: '53mm f/3.2 1/5800s ISO640' },
      barRatio: 0.08, brandRatio: 0.3, dividerW: 2 / 1200,
    });

    const dirty = document.createElement('canvas');
    draw(shared, dirty, wide, wideImg);         // scratch holds a ~214px-wide mark
    draw(shared, dirty, narrow, narrowImg);     // ...and a ~155px one lands on top
    const clean = document.createElement('canvas');
    draw(virgin, clean, narrow, narrowImg);     // same mark, no history at all
    return dirty.toDataURL() === clean.toDataURL();
  })()`);
  check("a mark renders the same with and without history", reuse === true, String(reuse));

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

  console.log("blur timestamp");
  // The blur template used to draw only [brand] model / params; the date existed
  // in the fields and appeared in the classic bar but nowhere here. It is the
  // third line now, and an empty date must not reserve a blank line.
  const blurDate = await evaluate(`(async () => {
    window.__cfg = window.__cfg || await (await fetch('/api/config')).json();
    const L = window.__cfg.spec.blur.layout;
    const c = document.getElementById('preview');
    const f = document.getElementById('f-shotAt');
    const settle = () => new Promise((r) => setTimeout(r, 340));
    const withDate = c.height;
    const keep = f.value;
    f.value = ''; f.dispatchEvent(new Event('input', { bubbles: true })); await settle();
    const withoutDate = c.height;
    f.value = keep; f.dispatchEvent(new Event('input', { bubbles: true })); await settle();
    return { withDate, withoutDate, back: c.height, line: c.width * L.textFont * L.lineGap };
  })()`);
  check("blur reserves a line for the timestamp", blurDate.withDate > blurDate.withoutDate,
    JSON.stringify(blurDate));
  check("that line is exactly one line-height", Math.abs((blurDate.withDate - blurDate.withoutDate) - blurDate.line) <= 1.5,
    `${blurDate.withDate - blurDate.withoutDate}px vs ${blurDate.line.toFixed(1)}px`);
  check("clearing the date restores the height", blurDate.back === blurDate.withDate);

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

  // The rule between logo and params used to be hard-wired at 1px, which read as
  // a stray line stuck to the brand mark. A 1px rule lands half-on/half-off a
  // pixel column and greys itself out; 2px is the smallest width that reads as a
  // separator, so that is the default, and 0 still means "don't draw it".
  const divider = await evaluate(`(async () => {
    const s = document.getElementById('s-dividerW');
    const c = document.getElementById('preview');
    const label = document.getElementById('v-dividerW').textContent;
    const settle = () => new Promise((r) => setTimeout(r, 320));
    const token = async (v) => {
      s.value = v; s.dispatchEvent(new Event('input')); await settle(); return c.toDataURL();
    };
    const on = c.toDataURL();               // as loaded, slider untouched
    const off = await token(0);             // 0 = don't draw it
    const thick = await token(0.005);       // 6px at the 1200px reference
    await token(0.0016666666666666668);     // back to the 2px default
    return { label, defaultOn: on !== off, thickDiffers: thick !== on };
  })()`);
  check("divider slider defaults to 2px", divider.label === "2px", divider.label);
  check("divider is drawn at the default", divider.defaultOn, String(divider.defaultOn));
  check("divider slider changes the rule", divider.thickDiffers, String(divider.thickDiffers));

  console.log("bar side");
  // One layout routine, four edges. A side bar is a strip along the photo's
  // long edge, so it adds *width*; top/bottom add height.
  const sides = await evaluate(`(async () => {
    const c = document.getElementById('preview');
    const ratio = Number(document.getElementById('s-barRatio').value);
    const barH = Math.round(1200 * ratio);   // the fixture renders 1200 wide
    const pick = (pos) => [...document.querySelectorAll('#barPosSeg button')].find(b => b.dataset.pos === pos).click();
    const settle = () => new Promise(r => setTimeout(r, 340));
    const corner = (x, y) => { const d = c.getContext('2d').getImageData(x, y, 1, 1).data; return [d[0], d[1], d[2]]; };
    const out = {};
    for (const p of ['bottom', 'top', 'left', 'right']) {
      pick(p); await settle();
      out[p] = {
        w: c.width, h: c.height,
        pressed: [...document.querySelectorAll('#barPosSeg button')]
          .filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.dataset.pos).join(','),
        // the bar side is the one whose leading corner is paper-white
        white: {
          top: corner(4, 4), bottom: corner(4, c.height - 4),
          left: corner(4, 4), right: corner(c.width - 4, 4),
        },
      };
    }
    pick('bottom'); await settle();
    return { barH, ...out, back: { w: c.width, h: c.height } };
  })()`);
  const isWhite = (px) => px[0] > 245 && px[1] > 245 && px[2] > 245;
  check("bottom bar adds only height", sides.bottom.w === 1200 && sides.bottom.h === 800 + sides.barH,
    `${sides.bottom.w}x${sides.bottom.h} barH=${sides.barH}`);
  check("top bar adds only height", sides.top.w === 1200 && sides.top.h === 800 + sides.barH,
    `${sides.top.w}x${sides.top.h}`);
  check("side bars add only width", sides.left.w === 1200 + sides.barH && sides.left.h === 800
    && sides.right.w === 1200 + sides.barH && sides.right.h === 800,
    `${sides.left.w}x${sides.left.h} / ${sides.right.w}x${sides.right.h}`);
  check("bottom bar sits on the bottom edge", isWhite(sides.bottom.white.bottom) && !isWhite(sides.bottom.white.top), JSON.stringify(sides.bottom.white));
  check("top bar sits on the top edge", isWhite(sides.top.white.top) && !isWhite(sides.top.white.bottom), JSON.stringify(sides.top.white));
  check("left bar sits on the left edge", isWhite(sides.left.white.left) && !isWhite(sides.right.white.left), JSON.stringify(sides.left.white));
  check("right bar sits on the right edge", isWhite(sides.right.white.right) && !isWhite(sides.left.white.right), JSON.stringify(sides.right.white));
  check("picking a side repaints the control", sides.right.pressed === "right" && sides.top.pressed === "top",
    `${sides.right.pressed} / ${sides.top.pressed}`);
  check("switching back restores the bottom bar", sides.back.h === sides.bottom.h && sides.back.w === sides.bottom.w,
    JSON.stringify(sides.back));

  // A side bar goes through the full-resolution export path too — the preview is
  // 1200px wide, an export can be 8000, and the strip maths has to hold there.
  const sideExport = await evaluate(`(async () => {
    [...document.querySelectorAll('#barPosSeg button')].find(b => b.dataset.pos === 'right').click();
    await new Promise((r) => setTimeout(r, 340));
    const errs = [];
    window.addEventListener('error', (e) => errs.push(e.message));
    document.getElementById('btnDownload').click();
    for (let i = 0; i < 60; i += 1) {
      if (/已导出/.test(document.getElementById('toast').textContent)) break;
      if (document.querySelector('.toast.err')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const bad = document.querySelector('.toast.err') ? document.getElementById('toast').textContent : '';
    [...document.querySelectorAll('#barPosSeg button')].find(b => b.dataset.pos === 'bottom').click();
    await new Promise((r) => setTimeout(r, 340));
    return { toast: document.getElementById('toast').textContent, bad, errs: errs.join('|') };
  })()`);
  check("side bar exports at full resolution", !sideExport.bad && !sideExport.errs && /已导出/.test(sideExport.toast),
    JSON.stringify(sideExport));

  console.log("font");
  const fonts = await evaluate(`(async () => {
    const cfg = window.__cfg || await (await fetch('/api/config')).json();
    const bad = [];
    for (const f of cfg.fonts) {
      if (!f.file) continue;
      const res = await fetch('/assets/fonts/' + f.file, { method: 'HEAD' });
      if (!res.ok) bad.push(f.key);
    }
    const sel = document.getElementById('fontSelect');
    const c = document.getElementById('preview');
    const settle = () => new Promise((r) => setTimeout(r, 480));
    const use = async (k) => { sel.value = k; sel.dispatchEvent(new Event('change')); await settle(); return c.toDataURL(); };
    const regular = await use(cfg.defaultFont);
    const bold = await use('maple-mono-nf-cn-bold');
    const thin = await use('maple-mono-nf-cn-thin');
    const back = await use(cfg.defaultFont);
    return {
      count: cfg.fonts.length, missing: bad, def: cfg.defaultFont,
      chosen: sel.value,
      boldDiffers: bold !== regular, thinDiffers: thin !== regular, restores: back === regular,
      loaded: [...document.fonts].filter((f) => f.status === 'loaded').length,
    };
  })()`);
  check("every bundled face is served", fonts.missing.length === 0, fonts.missing.join(","));
  check("font picker lists all faces", fonts.count >= 16, String(fonts.count));
  check("default face is Maple Mono Regular", fonts.def === "maple-mono-nf-cn-regular", fonts.def);
  check("picking a heavier face changes the pixels", fonts.boldDiffers === true);
  check("picking a lighter face changes the pixels", fonts.thinDiffers === true);
  check("picking the default again restores it", fonts.restores === true);
  console.log("  faces loaded:", fonts.loaded);

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

  console.log("portrait default side");
  // A portrait frame has its short edges on top and bottom, so a bar there eats
  // height that the photo cannot spare; it belongs on the right. Landscape is
  // the mirror case. The rule is exercised through the real upload path, so a
  // regression in addFiles() (not just in autoBarPos) shows up here.
  await evaluate(`(async () => {
    const src = document.createElement('canvas');
    src.width = 600; src.height = 900;
    const g = src.getContext('2d');
    g.fillStyle = '#2b3a4a'; g.fillRect(0, 0, 600, 900);
    g.fillStyle = '#c8a06a'; g.beginPath(); g.arc(400, 300, 150, 0, Math.PI * 2); g.fill();
    const blob = await new Promise((r) => src.toBlob(r, 'image/jpeg', 0.9));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'portrait.jpg', { type: 'image/jpeg' }));
    const input = document.getElementById('fileInput');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  const portrait = await evaluate(`(async () => {
    for (let i = 0; i < 60; i += 1) {
      if (document.getElementById('fileMeta').textContent.includes('portrait.jpg')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const c = document.getElementById('preview');
    const pressed = [...document.querySelectorAll('#barPosSeg button')]
      .filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.pos).join(',');
    const barH = Math.round(600 * Number(document.getElementById('s-barRatio').value));
    return { pressed, w: c.width, h: c.height, barH, meta: document.getElementById('fileMeta').textContent };
  })()`);
  check("portrait photo defaults to the right bar", portrait.pressed === "right", `${portrait.pressed} ${portrait.meta}`);
  check("right bar widens the canvas, not the height", portrait.w === 600 + portrait.barH && portrait.h === 900,
    `${portrait.w}x${portrait.h} (expected ${600 + portrait.barH}x900 = 600x900 + a ${portrait.barH}px strip)`);
  check("landscape still defaults to the bottom", await evaluate(`(async () => {
    const { autoBarPos } = await import('/js/render.js');
    const cfg = window.__cfg || await (await fetch('/api/config')).json();
    const t = cfg.spec.classic.autoBarPos;
    return autoBarPos(1200, 800, t) === 'bottom' && autoBarPos(800, 1200, t) === 'right' && autoBarPos(1000, 1000, t) === 'bottom';
  })()`));

  check("no uncaught page exceptions", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));

  console.log(`\n${pass} passed, ${fail} failed`);
} finally {
  ws.close();
  browser.kill();
}
process.exit(fail ? 1 : 0);
