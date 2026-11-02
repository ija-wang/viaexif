/* =============================================================================
 * app.js — UI orchestration.
 * Flow: upload -> readExif -> editable fields -> Canvas render -> download /
 * share / batch-zip. No framework, no build step.
 * ========================================================================== */
import { readExif, toFields, guessBrand } from "./exif.js";
import { render, paramLine, toBlob } from "./render.js";
import { zipStore, download } from "./zip.js";
import { sniffBytes, kindFromName, isNative, isLiveVideo, stemOf, humanSize } from "./formats.js";
import { readLiveVideo } from "./live.js";
import { reveal, splitChars, magnetic, tick, swap, fade, pulse } from "./motion.js";

const PREVIEW_WIDTH = 1400;
const MAX_FILES = 20;
const NATIVE_MIME = ["image/jpeg", "image/png", "image/webp"];
const DEFAULT_HINT = "导出不含任何限制，画质与原图一致。";

const state = {
  cfg: null,
  files: [],
  active: 0,
  template: "classic",
  sliders: {},
  format: "image/jpeg",
  quality: 0.92,
  busy: false,
  exports: 0,
};

const el = (id) => document.getElementById(id);

/* ================================================================== boot */
init();

async function init() {
  const forced = new URLSearchParams(location.search).get("theme");
  applyTheme(forced === "light" || forced === "dark" ? forced : localStorage.getItem("vx-theme") || "dark");

  try {
    const res = await fetch("/api/config");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.cfg = await res.json();
  } catch (err) {
    toast("配置加载失败，请刷新页面", true);
    console.error(err);
    return;
  }

  for (const tpl of state.cfg.templates) {
    state.sliders[tpl.id] = {};
    for (const [key, s] of Object.entries(state.cfg.spec[tpl.id].sliders)) {
      state.sliders[tpl.id][key] = s.default;
    }
  }

  buildTemplateCards();
  buildBrandMenu();
  buildFields();
  buildSliders();
  buildFormatSegments();
  bindEvents();
  applyInputFormats();
  bootMotion();
  updateChrome();

  // Brand logos are drawn on the canvas, so they must be decoded up front —
  // a canvas render can't wait for an async image load.
  loadBrandLogos(state.cfg.brands);
}

/* -------------------------------------------------------------- boot chrome */
function applyInputFormats() {
  const inputs = state.cfg.inputs || [];
  const exts = inputs.map((i) => `.${i.ext}`);
  // .mov is not an input format per se — it is the Live Photo companion.
  el("fileInput").accept = [...NATIVE_MIME, ...exts, ".mov", "video/quicktime"].join(",");
  const raw = inputs.filter((i) => i.kind === "raw").length;
  const caps = state.cfg.decode || {};
  const parts = ["JPG / PNG / WEBP", "HEIC / HEIF / AVIF"];
  if (raw) parts.push(`${raw} 种 RAW`);
  parts.push("实况照片");
  el("dzSub").textContent = `${parts.join(" · ")}　│　拖进来就行`;
  el("dzSub").title = caps.raw ? "" : "服务端未启用 RAW 解码";
}

function bootMotion() {
  document.querySelectorAll(".card, .topbar, .stage-bar").forEach((n) => n.classList.add("reveal"));
  reveal(document.querySelectorAll(".reveal"), { step: 55 });
  splitChars(el("dzTitle"));
  el("dzTitle")?.classList.add("split-in");
  magnetic(el("btnDownload"));
  magnetic(el("btnShare"));
  updateStats();
  // cursor spotlight inside each panel card
  let spotRaf = 0;
  let spotCard = null;
  let spotPos = { x: 0, y: 0 };
  document.querySelectorAll(".panel .card").forEach((card) => {
    card.addEventListener("pointermove", (e) => {
      const r = card.getBoundingClientRect();
      spotCard = card;
      spotPos = { x: e.clientX - r.left, y: e.clientY - r.top };
      if (spotRaf) return;
      spotRaf = requestAnimationFrame(() => {
        spotRaf = 0;
        if (!spotCard) return;
        spotCard.style.setProperty("--gx", `${spotPos.x}px`);
        spotCard.style.setProperty("--gy", `${spotPos.y}px`);
      });
    }, { passive: true });
  });

  const stage = el("stage");
  if (stage) {
    window.addEventListener("pointermove", (e) => {
      const r = stage.getBoundingClientRect();
      stage.style.setProperty("--mx", `${e.clientX - r.left}px`);
      stage.style.setProperty("--my", `${e.clientY - r.top}px`);
    }, { passive: true });
  }
}

/* ----------------------------------------------------------- brand logos */
const logoCache = new Map(); // brand.key -> HTMLImageElement
let logosReady = null;

function loadBrandLogos(brands) {
  const jobs = brands
    .filter((b) => b.logo && !logoCache.has(b.key))
    .map(
      (b) =>
        new Promise((resolve) => {
          const img = new Image();
          img.decoding = "async";
          img.onload = () => {
            logoCache.set(b.key, img);
            resolve();
          };
          img.onerror = resolve;
          img.src = `./assets/brands/${b.logo}`;
        })
    );
  logosReady = Promise.all(jobs).then(() => renderPreview());
  return logosReady;
}

function logoFor(brand) {
  return brand ? logoCache.get(brand.key) || null : null;
}

/* ---------------------------------------------------------------- theme */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("vx-theme", theme);
}

/* ------------------------------------------------------------ templates */
function buildTemplateCards() {
  const grid = el("tplGrid");
  grid.innerHTML = "";
  for (const tpl of state.cfg.templates) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tpl";
    btn.dataset.tpl = tpl.id;
    btn.innerHTML = `
      <span class="thumb"></span>
      <span class="tpl-meta">
        <span class="tpl-name">${tpl.name}</span>
        <span class="tpl-desc">${tpl.desc}</span>
      </span>`;
    btn.addEventListener("click", () => {
      state.template = tpl.id;
      document.querySelectorAll(".tpl").forEach((n) => {
        n.setAttribute("aria-pressed", String(n.dataset.tpl === tpl.id));
      });
      buildSliders();
      renderPreview();
    });
    btn.setAttribute("aria-pressed", String(tpl.id === state.template));
    grid.appendChild(btn);
  }
}

/* ---------------------------------------------------------------- brand */
function buildBrandMenu(filter = "") {
  const list = el("brandList");
  list.innerHTML = "";
  const q = filter.trim().toLowerCase();
  const opts = [{ key: null, name: "（不显示品牌）", color: "transparent" }, ...state.cfg.brands];
  const activeKey = activeFile()?.brandKey ?? null;

  for (const b of opts) {
    if (q && !`${b.name} ${b.key || ""}`.toLowerCase().includes(q)) continue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "opt";
    btn.setAttribute("role", "option");
    btn.setAttribute("aria-selected", String(b.key === activeKey));
    // show the actual logo when we have one, otherwise a colour dot
    btn.innerHTML = b.logo
      ? `<img class="ologo${b.tint ? " mono" : ""}" src="./assets/brands/${b.logo}" alt="" loading="lazy"><span class="oname">${b.name}</span>`
      : `<span class="dot" style="background:${b.color}"></span><span class="oname">${b.name}</span>`;
    btn.addEventListener("click", () => {
      const file = activeFile();
      if (file) file.brandKey = b.key;
      updateBrandTrigger();
      closeBrandMenu();
      renderPreview();
    });
    list.appendChild(btn);
  }
}

function brandOf(file) {
  if (!file || !file.brandKey) return null;
  return state.cfg.brands.find((b) => b.key === file.brandKey) || null;
}

function currentBrand() {
  return brandOf(activeFile());
}

function updateBrandTrigger() {
  const brand = currentBrand();
  const node = el("brandPreview");
  if (!brand) {
    node.innerHTML = "";
    node.textContent = "（不显示品牌）";
    node.style.color = "var(--muted)";
    return;
  }
  node.style.color = "";
  if (brand.logo) {
    node.innerHTML = `<img class="ologo trig${brand.tint ? " mono" : ""}" src="./assets/brands/${brand.logo}" alt="${brand.name}">`;
  } else {
    node.textContent = brand.name;
  }
  swap(node);
}

function openBrandMenu() {
  el("brandMenu").hidden = false;
  el("brandBtn").setAttribute("aria-expanded", "true");
  el("brandSearch").value = "";
  buildBrandMenu();
  el("brandSearch").focus();
}
function closeBrandMenu() {
  el("brandMenu").hidden = true;
  el("brandBtn").setAttribute("aria-expanded", "false");
}

/* --------------------------------------------------------------- fields */
function buildFields() {
  const grid = el("fieldGrid");
  grid.innerHTML = "";
  for (const f of state.cfg.fields) {
    const wrap = document.createElement("div");
    wrap.className = "field" + (f.group === "left" ? " full" : "");
    wrap.innerHTML = `
      <label for="f-${f.key}">${f.label}</label>
      <input type="text" id="f-${f.key}" data-key="${f.key}" placeholder="${f.placeholder}" spellcheck="false" />`;
    grid.appendChild(wrap);
  }
  grid.addEventListener("input", (e) => {
    const input = e.target.closest("input[data-key]");
    const file = activeFile();
    if (!input || !file) return;
    file.fields[input.dataset.key] = input.value;
    schedulePreview();
  });
}

function syncFieldsToInputs() {
  const file = activeFile();
  const fields = file?.fields || {};
  for (const f of state.cfg.fields) {
    const input = el(`f-${f.key}`);
    if (input) input.value = fields[f.key] || "";
  }
}

/* -------------------------------------------------------------- sliders */
function buildSliders() {
  const box = el("sliderBox");
  box.innerHTML = "";
  const spec = state.cfg.spec[state.template];
  for (const [key, s] of Object.entries(spec.sliders)) {
    const block = document.createElement("div");
    block.className = "slider-block";
    block.innerHTML = `
      <div class="field" style="margin-bottom:6px">
        <label for="s-${key}">${s.label} <span class="val" id="v-${key}">${pct(state.sliders[state.template][key])}</span></label>
      </div>
      <input type="range" id="s-${key}" min="${s.min}" max="${s.max}" step="${s.step}" value="${state.sliders[state.template][key]}" />
      <p class="hint">${s.hint}</p>`;
    const range = block.querySelector("input");
    paintRange(range);
    range.addEventListener("input", () => {
      state.sliders[state.template][key] = Number(range.value);
      el(`v-${key}`).textContent = pct(range.value);
      paintRange(range);
      schedulePreview();
    });
    box.appendChild(block);
  }
}

const pct = (v) => `${Math.round(Number(v) * 100)}%`;

/** Colour the filled part of a range track (pure CSS var, no gradient math). */
function paintRange(input) {
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const value = Number(input.value);
  const ratio = max > min ? (value - min) / (max - min) : 0;
  input.style.setProperty("--fill", `${(ratio * 100).toFixed(1)}%`);
}

/* -------------------------------------------------------------- formats */
function buildFormatSegments() {
  const seg = el("formatSeg");
  seg.innerHTML = "";
  const caps = state.cfg.decode || {};
  const usable = state.cfg.formats.filter((f) => !f.server || caps.heicEncode);
  if (!usable.some((f) => f.id === state.format)) state.format = usable[0].id;
  for (const f of usable) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = f.label;
    btn.title = f.server ? "在服务端用 libheif 编码" : "";
    btn.setAttribute("aria-pressed", String(f.id === state.format));
    btn.addEventListener("click", () => {
      state.format = f.id;
      seg.querySelectorAll("button").forEach((n) =>
        n.setAttribute("aria-pressed", String(n.textContent === f.label)));
      el("qualityField").hidden = !f.quality;
      el("btnShare").disabled = !activeFile() || Boolean(f.server);
      updateChrome();
    });
    seg.appendChild(btn);
  }
  el("qualityField").hidden = !usable.find((f) => f.id === state.format).quality;
}

/* --------------------------------------------------------------- events */
function bindEvents() {
  const dz = el("dropzone");
  const input = el("fileInput");
  const wrap = el("canvasWrap");

  dz.addEventListener("click", () => input.click());
  dz.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); }
  });
  el("btnReplace").addEventListener("click", () => input.click());
  el("btnBatchMode").addEventListener("click", () => input.click());

  input.addEventListener("change", () => {
    if (input.files?.length) addFiles([...input.files]);
    input.value = "";
  });

  ["dragenter", "dragover"].forEach((ev) =>
    wrap.addEventListener(ev, (e) => { e.preventDefault(); wrap.classList.add("dragging"); }));
  ["dragleave", "drop"].forEach((ev) =>
    wrap.addEventListener(ev, (e) => {
      e.preventDefault();
      if (ev === "dragleave" && wrap.contains(e.relatedTarget)) return;
      wrap.classList.remove("dragging");
    }));
  wrap.addEventListener("drop", (e) => {
    const files = [...(e.dataTransfer?.files || [])].filter(
      (f) => isLiveVideo(f.name) || kindFromName(f.name) || /^image\//.test(f.type)
    );
    if (files.length) addFiles(files);
    else toast("未识别到可用的图片或实况视频", true);
  });

  window.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) addFiles(files);
  });

  el("brandBtn").addEventListener("click", () =>
    (el("brandMenu").hidden ? openBrandMenu() : closeBrandMenu()));
  el("brandSearch").addEventListener("input", (e) => buildBrandMenu(e.target.value));
  document.addEventListener("click", (e) => {
    if (!el("brandSelect").contains(e.target)) closeBrandMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeBrandMenu();
  });

  el("btnTheme").addEventListener("click", () =>
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));

  el("btnReset").addEventListener("click", () => {
    const file = activeFile();
    if (!file) return;
    file.fields = toFields(file.exif);
    syncFieldsToInputs();
    schedulePreview();
    toast("已按 EXIF 重建参数");
  });

  el("btnApplyAll").addEventListener("click", () => {
    const src = activeFile();
    if (!src) return;
    for (const f of state.files) {
      if (f === src) continue;
      f.fields = { ...src.fields };
      f.brandKey = src.brandKey;
    }
    toast(`已应用到 ${state.files.length} 张图片`);
  });

  el("quality").addEventListener("input", (e) => {
    state.quality = Number(e.target.value) / 100;
    el("qualityVal").textContent = `${e.target.value}%`;
    paintRange(e.target);
  });
  paintRange(el("quality"));

  el("btnDownload").addEventListener("click", () => exportActive());
  el("btnShare").addEventListener("click", () => shareActive());
  el("btnZip").addEventListener("click", () => exportZip());
  el("btnLive").addEventListener("click", () => exportLive());

  window.addEventListener("resize", () => schedulePreview());
}

/* ---------------------------------------------------------------- files */
/** Live Photo companions seen so far, keyed by filename stem. Kept across
 *  drops so dropping the .MOV first (or second) still pairs up. */
const liveByStem = new Map();

async function addFiles(list) {
  const room = MAX_FILES - state.files.length;
  if (room <= 0) { toast(`最多一次处理 ${MAX_FILES} 张`, true); return; }

  // A Live Photo arrives as two files. Pair the .MOV up front so the HEIC we
  // decode a moment later can carry it.
  const videos = list.filter((f) => isLiveVideo(f.name));
  const photos = list.filter((f) => !isLiveVideo(f.name));
  for (const video of videos) {
    const info = await readLiveVideo(video);
    liveByStem.set(stemOf(video.name), info);
  }
  if (!photos.length) {
    if (!videos.length) return;
    // A late-arriving .MOV can still light up a photo that is already queued.
    let patched = 0;
    for (const queued of state.files) {
      const info = liveByStem.get(stemOf(queued.name));
      if (info?.isLive && !queued.live) {
        queued.live = info;
        patched += 1;
      }
    }
    if (patched) {
      afterFilesChanged();
      toast(`已配对上 ${patched} 张实况照片`);
    } else {
      toast("这个 MOV 还没有同名的 HEIC", true);
    }
    return;
  }

  const firstNew = state.files.length;
  const queue = photos.slice(0, room);
  hud(true, "", 0);

  for (let i = 0; i < queue.length; i += 1) {
    const file = queue[i];
    const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
    const sniffed = sniffBytes(head);
    const byExt = kindFromName(file.name);
    // A DNG/NEF/ARW is a TIFF container, so magic alone only tells us "tiff".
    let kind = sniffed?.kind || byExt;
    if (kind === "tiff" && byExt === "raw") kind = "raw";
    if (!kind) { toast(`${file.name} 格式不支持`, true); continue; }
    const label = kind === "raw" && (!sniffed || sniffed.kind === "tiff") ? "RAW" : (sniffed?.label || kind.toUpperCase());

    try {
      let exif;
      let bitmap;
      let remote = null;

      if (isNative(kind)) {
        hud(true, `${file.name} · 读取 EXIF`, (i / queue.length) * 100);
        exif = readExif(await file.arrayBuffer());
        bitmap = await createImageBitmap(file);
      } else {
        hud(true, `${file.name} · 上传`, (i / queue.length) * 100);
        const decoded = await decodeRemote(file, (p) => {
          hud(true, `${file.name} · 上传 ${Math.round(p * 100)}%`, ((i + p) / queue.length) * 100);
        });
        hud(true, `${file.name} · ${decoded.raw ? "RAW 解码" : "解码"}中…`, ((i + 0.9) / queue.length) * 100);
        exif = decoded.exif || {};
        bitmap = await bitmapFromUrl(decoded.url);
        remote = {
          url: decoded.url,
          label: decoded.label || label,
          raw: Boolean(decoded.raw),
          ms: decoded.ms || 0,
        };
      }

      const width = bitmap.width;
      const height = bitmap.height;
      const preview = await downscale(bitmap, PREVIEW_WIDTH);
      const thumb = await thumbFrom(preview, 200);
      bitmap.close?.();

      const live = liveByStem.get(stemOf(file.name)) || null;
      state.files.push({
        id: crypto.randomUUID(),
        file,
        name: file.name,
        width,
        height,
        preview,
        thumb,
        remote,
        exif,
        fields: toFields(exif),
        brandKey: guessBrand(exif, state.cfg.brandHints),
        kind: remote ? remote.label : label,
        live: live?.isLive ? live : null,
      });
    } catch (err) {
      console.error(err);
      toast(`${file.name}：${err.message || "读取失败"}`, true);
    }
    hud(true, "", ((i + 1) / queue.length) * 100);
  }

  hud(false);
  if (state.files.length > firstNew) state.active = firstNew;
  else if (state.files.length) state.active = Math.min(state.active, state.files.length - 1);
  afterFilesChanged();
}

/** POST a camera-native file to the local container and get a JPEG back. */
function decodeRemote(file, onUpload) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/decode");
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onUpload?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      const body = xhr.response || {};
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error(body.error || `解码失败 (HTTP ${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("无法连接服务端，HEIC / RAW 需要它来解码"));
    const fd = new FormData();
    fd.append("file", file, file.name);
    xhr.send(fd);
  });
}

async function bitmapFromUrl(url) {
  const res = await fetch(url, { cache: "force-cache" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "解码结果已过期");
  }
  return createImageBitmap(await res.blob());
}

async function thumbFrom(bitmap, width) {
  const scale = Math.min(1, width / bitmap.width);
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const off = document.createElement("canvas");
  off.width = w;
  off.height = h;
  off.getContext("2d").drawImage(bitmap, 0, 0, w, h);
  return off.toDataURL("image/jpeg", 0.72);
}

async function downscale(bitmap, maxWidth) {
  if (bitmap.width <= maxWidth) {
    // still return a detached bitmap so closing the original is safe
    return createImageBitmap(bitmap);
  }
  const scale = maxWidth / bitmap.width;
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  try {
    return await createImageBitmap(bitmap, { resizeWidth: w, resizeHeight: h, resizeQuality: "high" });
  } catch {
    const off = document.createElement("canvas");
    off.width = w;
    off.height = h;
    const ctx = off.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, w, h);
    return createImageBitmap(off);
  }
}

/** Full-resolution pixels for export: local file, or the server's cached frame. */
async function fullBitmapOf(file) {
  if (!file.remote) return createImageBitmap(file.file);
  try {
    return await bitmapFromUrl(file.remote.url);
  } catch (err) {
    throw new Error("解码结果已过期（15 分钟），请重新拖入这张照片");
  }
}

async function withFullBitmap(file, fn) {
  const bmp = await fullBitmapOf(file);
  try {
    return await fn(bmp);
  } finally {
    bmp.close?.();
  }
}

function activeFile() {
  return state.files[state.active] || null;
}

function afterFilesChanged() {
  buildQueue();
  syncFieldsToInputs();
  updateBrandTrigger();
  updateChrome();
  renderPreview();
}

function buildQueue() {
  const queue = el("queue");
  queue.hidden = state.files.length < 2;
  queue.innerHTML = "";
  if (queue.hidden) return;

  state.files.forEach((f, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "qitem" + (i === state.active ? " active" : "");
    btn.title = f.name;
    btn.innerHTML = `<img alt=""><span class="qname">${shortName(f.name)}</span>`;
    btn.querySelector("img").src = thumbUrl(f);
    const tags = [];
    if (f.remote?.raw) tags.push("RAW");
    else if (f.remote) tags.push("HEIC");
    if (f.live) tags.push("LIVE");
    if (tags.length) {
      const badge = document.createElement("span");
      badge.className = "qbadge";
      badge.textContent = tags.join(" ");
      btn.appendChild(badge);
    }
    btn.addEventListener("click", () => {
      state.active = i;
      buildQueue();
      syncFieldsToInputs();
      updateBrandTrigger();
      updateChrome();
      renderPreview();
    });

    const del = document.createElement("button");
    del.type = "button";
    del.className = "qdel";
    del.textContent = "×";
    del.title = "移除";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      const [removed] = state.files.splice(i, 1);
      removed?.preview?.close?.();
      if (state.active >= state.files.length) state.active = Math.max(0, state.files.length - 1);
      afterFilesChanged();
    });
    btn.appendChild(del);
    queue.appendChild(btn);
  });
}

const thumbCache = new WeakMap();
function thumbUrl(file) {
  if (thumbCache.has(file.file)) return thumbCache.get(file.file);
  // Object URLs of HEIC / RAW files do not render in Chromium, so the queue
  // uses a JPEG thumbnail baked from the preview bitmap instead.
  const url = file.thumb || URL.createObjectURL(file.file);
  thumbCache.set(file.file, url);
  return url;
}

const shortName = (n) => (n.length > 14 ? `${n.slice(0, 8)}…${n.slice(-4)}` : n);

/* -------------------------------------------------------------- preview */
let rafId = 0;
function schedulePreview() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    renderPreview();
  });
}

let lastRenderedId = null;

function renderPreview() {
  const file = activeFile();
  const canvas = el("preview");
  const dz = el("dropzone");

  if (!file) {
    canvas.hidden = true;
    dz.hidden = false;
    return;
  }
  dz.hidden = true;
  canvas.hidden = false;

  if (file.id !== lastRenderedId) {
    lastRenderedId = file.id;
    fade(canvas);
  }

  try {
    render(canvas, file.preview, {
      template: state.template,
      spec: state.cfg.spec[state.template],
      brand: currentBrand(),
      logoImg: logoFor(currentBrand()),
      fields: { ...file.fields, params: paramLine(file.fields) },
      barRatio: state.sliders[state.template].barRatio,
      brandRatio: state.sliders[state.template].brandRatio,
    });
  } catch (err) {
    console.error(err);
    toast(err.message || "预览失败", true);
  }
}

/* --------------------------------------------------------------- export */
async function composeActive() {
  const file = activeFile();
  if (!file) throw new Error("请先上传图片");
  const fmt = state.cfg.formats.find((f) => f.id === state.format);
  const blob = await withFullBitmap(file, async (bmp) => {
    const canvas = document.createElement("canvas");
    render(canvas, bmp, {
      template: state.template,
      spec: state.cfg.spec[state.template],
      brand: currentBrand(),
      logoImg: logoFor(currentBrand()),
      fields: { ...file.fields, params: paramLine(file.fields) },
      barRatio: state.sliders[state.template].barRatio,
      brandRatio: state.sliders[state.template].brandRatio,
    });
    const out = await toOutputBlob(canvas);
    canvas.width = canvas.height = 0;
    return out;
  });
  return { blob, ext: fmt.ext, name: file.name };
}

/** Canvas writes JPEG/PNG/WEBP; HEIC needs one round-trip to the container. */
async function toOutputBlob(canvas) {
  const fmt = state.cfg.formats.find((f) => f.id === state.format);
  if (!fmt?.server) return toBlob(canvas, state.format, state.quality);

  const frame = await toBlob(canvas, "image/jpeg", Math.max(0.92, state.quality));
  const fd = new FormData();
  fd.append("file", frame, "frame.jpg");
  fd.append("format", "heic");
  fd.append("quality", String(Math.round(state.quality * 100)));
  const res = await fetch("/api/encode", { method: "POST", body: fd });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "HEIC 编码失败");
  }
  return res.blob();
}

function outName(name, tplId) {
  const base = name.replace(/\.[^.]+$/, "");
  return `${base}-${tplId === "classic" ? "classic" : "blur"}`;
}

async function exportActive() {
  if (state.busy) return;
  state.busy = true;
  setBusy(true, "正在导出…");
  try {
    const { blob, ext, name } = await composeActive();
    download(blob, `${outName(name, state.template)}.${ext}`);
    state.exports += 1;
    updateStats();
    toast(`已导出 ${(blob.size / 1024 / 1024).toFixed(2)} MB`);
  } catch (err) {
    console.error(err);
    toast(err.message || "导出失败", true);
  } finally {
    state.busy = false;
    setBusy(false);
    el("exportHint").textContent = DEFAULT_HINT;
  }
}

async function shareActive() {
  if (state.busy) return;
  state.busy = true;
  setBusy(true, "正在生成链接…");
  try {
    const { blob, ext, name } = await composeActive();
    const form = new FormData();
    form.append("file", blob, `${outName(name, state.template)}.${ext}`);
    const res = await fetch("/api/share", { method: "POST", body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `上传失败 (${res.status})`);
    const url = new URL(data.url, location.origin).href;
    await copy(url);
    toast(`链接已复制：${url}`);
    el("exportHint").innerHTML =
      `分享链接：<a href="${url}" target="_blank" rel="noopener" style="color:var(--accent)">${url}</a>`;
  } catch (err) {
    console.error(err);
    toast(err.message || "生成链接失败", true);
  } finally {
    state.busy = false;
    setBusy(false);
  }
}

async function exportZip() {
  if (state.busy || state.files.length < 2) return;
  state.busy = true;
  setBusy(true, "正在批量渲染…");
  try {
    const fmt = state.cfg.formats.find((f) => f.id === state.format);
    const entries = [];
    for (let i = 0; i < state.files.length; i += 1) {
      const file = state.files[i];
      setBusy(true, `正在渲染 ${i + 1}/${state.files.length}`);
      const blob = await withFullBitmap(file, async (bmp) => {
        const canvas = document.createElement("canvas");
        render(canvas, bmp, {
          template: state.template,
          spec: state.cfg.spec[state.template],
          brand: brandOf(file),
        logoImg: logoFor(brandOf(file)),
          fields: { ...file.fields, params: paramLine(file.fields) },
          barRatio: state.sliders[state.template].barRatio,
          brandRatio: state.sliders[state.template].brandRatio,
        });
        const out = await toOutputBlob(canvas);
        canvas.width = canvas.height = 0;
        return out;
      });
      entries.push({
        name: `${outName(file.name, state.template)}.${fmt.ext}`,
        data: new Uint8Array(await blob.arrayBuffer()),
      });
      await new Promise((r) => setTimeout(r, 0)); // let the UI breathe
    }
    download(zipStore(entries), `viaexif-${state.template}-${entries.length}.zip`);
    state.exports += 1;
    updateStats();
    toast(`已打包 ${entries.length} 张图片`);
  } catch (err) {
    console.error(err);
    toast(err.message || "批量导出失败", true);
  } finally {
    state.busy = false;
    setBusy(false);
    el("exportHint").textContent = DEFAULT_HINT;
  }
}

/**
 * Live Photo companion export: the watermarked still plus the untouched .MOV.
 *
 * Apple pairs the two by a content identifier stored in the HEIC container,
 * which a canvas cannot write, so this is packaged as material rather than a
 * ready-made Live Photo — the UI says exactly that.
 */
async function exportLive() {
  const file = activeFile();
  if (state.busy || !file?.live?.file) return;
  state.busy = true;
  setBusy(true, "正在打包实况素材…");
  try {
    const base = outName(file.name, state.template);
    const blob = await withFullBitmap(file, async (bmp) => {
      const canvas = document.createElement("canvas");
      render(canvas, bmp, {
        template: state.template,
        spec: state.cfg.spec[state.template],
        brand: currentBrand(),
        logoImg: logoFor(currentBrand()),
        fields: { ...file.fields, params: paramLine(file.fields) },
        barRatio: state.sliders[state.template].barRatio,
        brandRatio: state.sliders[state.template].brandRatio,
      });
      const out = await toBlob(canvas, "image/jpeg", state.quality);
      canvas.width = canvas.height = 0;
      return out;
    });
    const mov = new Uint8Array(await file.live.file.arrayBuffer());
    download(
      zipStore([
        { name: `${base}.jpg`, data: new Uint8Array(await blob.arrayBuffer()) },
        { name: file.live.name, data: mov },
      ]),
      `${base}-live.zip`
    );
    state.exports += 1;
    updateStats();
    toast("已打包：水印静图 + 原实况视频");
  } catch (err) {
    console.error(err);
    toast(err.message || "实况导出失败", true);
  } finally {
    state.busy = false;
    setBusy(false);
    el("exportHint").textContent = DEFAULT_HINT;
  }
}

/* ----------------------------------------------------------------- chrome */
function updateChrome() {
  const file = activeFile();
  const many = state.files.length > 1;
  const fmt = state.cfg.formats.find((f) => f.id === state.format);

  el("btnDownload").disabled = !file || state.busy;
  el("btnShare").disabled = !file || state.busy || Boolean(fmt?.server);
  el("btnReset").disabled = !file;
  el("btnZip").hidden = !many;
  el("btnApplyAll").hidden = !many;
  el("btnLive").hidden = !file?.live;
  el("zipCount").textContent = String(state.files.length);

  if (!file) {
    el("fileMeta").textContent = "尚未选择图片";
    updateStats();
    return;
  }
  const tags = [];
  if (file.remote) tags.push(file.remote.label || "RAW");
  if (file.live) tags.push(file.live.duration ? `实况 ${file.live.duration.toFixed(1)}s` : "实况");
  const dims = `${file.width}×${file.height}`;
  const size = (file.file.size / 1024 / 1024).toFixed(2);
  const pos = many ? ` · ${state.active + 1}/${state.files.length}` : "";
  el("fileMeta").textContent =
    `${file.name} · ${tags.length ? tags.join(" · ") + " · " : ""}${dims} · ${size} MB${pos}`;
  updateStats();
}

function updateStats() {
  const mb = state.files.reduce((n, f) => n + f.file.size, 0) / 1024 / 1024;
  const sizeLabel = (v) => (v >= 10 ? `${Math.round(v)} MB` : `${v.toFixed(1)} MB`);
  tick(el("statCount"), state.files.length, (v) => String(Math.round(v)));
  tick(el("statSize"), mb, sizeLabel);
  tick(el("statExports"), state.exports || 0, (v) => String(Math.round(v)));
}

/** Decode HUD: upload percentage, then an honest "解码中" shimmer. */
let hudTimer = 0;
function hud(show, text, pct = 0) {
  const box = el("hud");
  if (!box) return;
  clearTimeout(hudTimer);
  if (show) {
    box.hidden = false;
    if (text) el("hudLabel").textContent = text;
    const value = Math.max(0.03, Math.min(1, pct / 100));
    el("hudFill").style.transform = `scaleX(${value})`;
    box.classList.toggle("indeterminate", /解码|读取 EXIF/.test(text || ""));
  } else {
    box.classList.remove("indeterminate");
    el("hudFill").style.transform = "scaleX(1)";
    hudTimer = setTimeout(() => {
      box.hidden = true;
      el("hudFill").style.transform = "scaleX(0)";
    }, 280);
  }
}

function setBusy(busy, text) {
  document.body.style.cursor = busy ? "progress" : "";
  if (busy && text) el("exportHint").textContent = text;
}

/* ------------------------------------------------------------------ misc */
async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    return false;
  }
}

let toastTimer = 0;
function toast(message, isError = false) {
  const node = el("toast");
  node.textContent = message;
  node.classList.toggle("err", isError);
  node.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("show"), isError ? 4200 : 2600);
}
