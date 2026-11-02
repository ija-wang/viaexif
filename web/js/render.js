/* =============================================================================
 * render.js — Canvas renderer. Single rendering engine for preview, download,
 * batch export and share upload, so what you see is exactly what you get.
 *
 * Layout numbers come from /api/config (server/config.py) — never hardcode.
 * ========================================================================== */

const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", ' +
  '"Microsoft YaHei", "Noto Sans SC", sans-serif';

const MAX_EXPORT_WIDTH = 8192;

function font(size, weight = 500, tracking = 0) {
  return { size, weight, tracking, css: `${weight} ${Math.max(1, size).toFixed(2)}px ${FONT_STACK}` };
}

function setFont(ctx, f) {
  ctx.font = f.css;
  if ("letterSpacing" in ctx) ctx.letterSpacing = `${(f.tracking || 0).toFixed(3)}px`;
}

function measure(ctx, text, f) {
  setFont(ctx, f);
  return ctx.measureText(text).width;
}

function fitFont(ctx, text, base, maxWidth, minScale = 0.62) {
  if (!text) return base;
  const w = measure(ctx, text, base);
  if (w <= maxWidth) return base;
  const scale = Math.max(minScale, maxWidth / w);
  return font(base.size * scale, base.weight, base.tracking);
}

/* ------------------------------------------------------------------- brand */
// Brand logos are SVG files at /assets/brands/<file>, pre-loaded by app.js.
// `tint` brands are single-ink (black) marks: on a dark canvas they must be
// repainted in the template text colour, otherwise they disappear.
let scratch = null;

function scratchOf(w, h) {
  if (!scratch) scratch = document.createElement("canvas");
  const needW = Math.ceil(w), needH = Math.ceil(h);
  if (scratch.width < needW || scratch.height < needH) {
    scratch.width = Math.max(scratch.width, needW);
    scratch.height = Math.max(scratch.height, needH);
  }
  const c = scratch.getContext("2d");
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalCompositeOperation = "source-over";
  c.clearRect(0, 0, needW, needH);
  return c;
}

/**
 * Width a brand mark will occupy when drawn `h` px tall.
 * With a logo asset it's the viewBox aspect; without one it's the name text.
 */
export function brandMarkWidth(ctx, brand, h) {
  if (!brand) return 0;
  if (brand.logo) return h * (brand.aspect || 3);
  return measure(ctx, brand.name, font(h * 0.86, 600));
}

/**
 * Draw a brand mark `h` px tall. `x` is the anchor: right edge when
 * `align === "right"`, left edge otherwise. Returns the drawn width.
 * Falls back to the brand name when the logo asset or bitmap is missing.
 */
function drawBrandMark(ctx, opts, x, y, h, align) {
  const { brand, logoImg, spec } = opts;
  if (!brand) return 0;
  const right = align === "right";
  const w = brandMarkWidth(ctx, brand, h);
  const left = right ? x - w : x;

  if (logoImg && brand.logo) {
    if (brand.tint) {
      // repaint the single-ink mark in the template's text colour
      const c = scratchOf(w, h);
      c.drawImage(logoImg, 0, 0, w, h);
      c.globalCompositeOperation = "source-in";
      c.fillStyle = spec.colors.text;
      c.fillRect(0, 0, w, h);
      c.globalCompositeOperation = "source-over";
      ctx.drawImage(scratch, 0, 0, Math.ceil(w), Math.ceil(h), left, y, w, h);
    } else {
      ctx.drawImage(logoImg, left, y, w, h);
    }
    return w;
  }

  // ---- text fallback (brand has no logo asset)
  const f = font(h * 0.86, 600);
  ctx.textAlign = right ? "right" : "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = spec.colors.text;
  setFont(ctx, f);
  ctx.fillText(brand.name, x, y + h / 2 + f.size * 0.02);
  ctx.textAlign = "left";
  return w;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {ImageBitmap|HTMLImageElement} image
 * @param {object} opts {template, spec, brand, fields, barRatio, brandRatio, quality(scale)}
 */
export function render(canvas, image, opts) {
  const { template, spec, brand, fields } = opts;
  const srcW = image.width || image.naturalWidth;
  const srcH = image.height || image.naturalHeight;
  if (!srcW || !srcH) throw new Error("图片尚未解码");

  const maxW = Math.min(srcW, MAX_EXPORT_WIDTH);
  const k = maxW / srcW;
  const W = Math.round(srcW * k);
  const H = Math.round(srcH * k);

  const ctx = canvas.getContext("2d", { alpha: template === "blur" });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (template === "classic") {
    drawClassic(ctx, canvas, image, W, H, opts);
  } else {
    drawBlur(ctx, canvas, image, W, H, opts);
  }
  return { width: canvas.width, height: canvas.height };
}

/* ------------------------------------------------------------------ classic */
function drawClassic(ctx, canvas, image, W, H, opts) {
  const { spec, brand, fields } = opts;
  const L = spec.layout;
  const C = spec.colors;
  const barH = Math.max(12, Math.round(W * opts.barRatio));
  const totalH = H + barH;

  canvas.width = W;
  canvas.height = totalH;

  ctx.fillStyle = C.bar;
  ctx.fillRect(0, 0, W, totalH);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, 0, 0, W, H);

  const barTop = H;
  const cy = barTop + barH / 2;
  const padX = W * L.barPadX;
  const params = fields.params;
  const gap = barH * L.gap;
  const divW = Math.max(1, barH * L.dividerW);

  // ---- 1) size the right block first, capped at 58% of the canvas width
  let paramF = font(barH * L.paramFont, 500);
  let markH = barH * L.brandFont * (opts.brandRatio / 0.3);
  const rightCap = W * 0.58;
  let rightW = 0;
  for (let i = 0; i < 16; i += 1) {
    const markW = brand ? brandMarkWidth(ctx, brand, markH) : 0;
    rightW = measure(ctx, params, paramF) + (brand ? markW + gap * 2 + divW : 0);
    if (rightW <= rightCap) break;
    // overflow -> shrink both, keeping their ratio
    paramF = font(paramF.size * 0.94, paramF.weight);
    markH *= 0.94;
  }

  // ---- 2) give the left block whatever is left, minus a safety gutter
  const gutter = barH * 0.45;
  const leftAvail = Math.max(W * 0.18, W * (1 - 2 * L.barPadX) - rightW - gutter);
  const modelF = fitFont(ctx, fields.model, font(barH * L.modelFont, 600), leftAvail);
  const dateF = fitFont(ctx, fields.shotAt, font(barH * L.dateFont, 500), leftAvail);

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = C.text;
  setFont(ctx, modelF);
  if (fields.model) ctx.fillText(fields.model, padX, barTop + barH * L.modelBaseline);
  ctx.fillStyle = C.sub;
  setFont(ctx, dateF);
  if (fields.shotAt) ctx.fillText(fields.shotAt, padX, barTop + barH * L.dateBaseline);

  // ---- 3) draw the right block: [brand logo] [divider] [params]
  {
    const rightX = W * (1 - L.barPadX);
    const pw = measure(ctx, params, paramF);
    const paramLeft = rightX - pw;

    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillStyle = C.text;
    setFont(ctx, paramF);
    if (params) ctx.fillText(params, rightX, cy);

    if (brand) {
      const divX = paramLeft - gap - divW;
      const divH = barH * L.dividerH;
      ctx.fillStyle = C.divider;
      ctx.fillRect(divX, cy - divH / 2, divW, divH);

      drawBrandMark(ctx, opts, divX - gap, cy - markH / 2, markH, "right");
    }
  }
  ctx.textBaseline = "alphabetic";
}

/* --------------------------------------------------------------------- blur */
function drawBlur(ctx, canvas, image, W, H, opts) {
  const { spec, brand, fields } = opts;
  const L = spec.layout;
  const C = spec.colors;

  canvas.width = W;
  canvas.height = H;

  // ---- background: cover-cropped, blurred, slightly darkened
  ctx.save();
  if ("filter" in ctx) ctx.filter = `blur(${Math.max(6, Math.round(W * L.bgBlur))}px)`;
  const cover = coverRect(W, H, W, H);
  ctx.drawImage(image, cover.x, cover.y, cover.w, cover.h);
  ctx.restore();

  if ("filter" in ctx) ctx.filter = "none";
  ctx.fillStyle = `rgba(0,0,0,${L.bgDarken})`;
  ctx.fillRect(0, 0, W, H);

  // ---- inset photo
  const padX = W * L.padX;
  const padTop = W * L.padTop;
  const radius = W * L.radius;
  const textF = font(W * L.textFont, 500);
  const line2Y = H - W * L.line2Baseline;
  const line1Y = line2Y - textF.size * L.lineGap;
  const photoBottom = line1Y - textF.size * L.photoGapAboveText - textF.size;
  const photoW = W - padX * 2;
  const photoH = Math.max(40, photoBottom - padTop);

  ctx.save();
  roundRectPath(ctx, padX, padTop, photoW, photoH, radius);
  ctx.clip();
  const inner = coverRect(photoW, photoH, W, H);
  ctx.drawImage(image, padX + inner.x, padTop + inner.y, inner.w, inner.h);
  ctx.restore();

  // ---- text line 1: [Brand logo] [Model], centred
  let markH = textF.size * L.brandFont * (opts.brandRatio / 0.3);
  let modelF = font(textF.size, 500, 0.2);
  let paramF = font(textF.size, 500, 0.2);

  const maxLine = W - padX * 2;
  const gap = textF.size * L.brandGap;
  const modelW = measure(ctx, fields.model, modelF);
  let brandW = brand ? brandMarkWidth(ctx, brand, markH) : 0;
  const shrink = Math.min(1, maxLine / Math.max(1, brandW + gap + modelW));
  if (shrink < 1) {
    modelF = font(modelF.size * shrink, modelF.weight, modelF.tracking);
    markH *= shrink;
    brandW = brand ? brandMarkWidth(ctx, brand, markH) : 0;
  }
  paramF = fitFont(ctx, fields.params, paramF, maxLine);

  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.shadowColor = C.shadow;
  ctx.shadowBlur = Math.max(2, textF.size * 0.35);
  ctx.shadowOffsetY = 1;

  const lineW = (brand ? brandW + gap : 0) + measure(ctx, fields.model, modelF);
  let x = (W - lineW) / 2;
  if (brand) {
    // vertical-centre the mark on the model text's optical centre
    const centreY = line1Y - modelF.size * 0.34;
    drawBrandMark(ctx, opts, x, centreY - markH / 2, markH, "left");
    x += brandW + gap;
  }
  if (fields.model) {
    ctx.fillStyle = C.text;
    setFont(ctx, modelF);
    ctx.fillText(fields.model, x, line1Y);
  }

  if (fields.params) {
    ctx.textAlign = "center";
    ctx.fillStyle = C.text;
    setFont(ctx, paramF);
    ctx.fillText(fields.params, W / 2, line2Y);
  }
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
}

/* ------------------------------------------------------------------ helpers */
function coverRect(boxW, boxH, srcW, srcH) {
  const scale = Math.max(boxW / srcW, boxH / srcH);
  const w = srcW * scale;
  const h = srcH * scale;
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

/** Compose the single "param" string shown on the right of the classic bar. */
export function paramLine(fields) {
  return [fields.focal, fields.aperture, fields.shutter, fields.iso]
    .map((s) => (s || "").trim())
    .filter(Boolean)
    .join(" ");
}

export function toBlob(canvas, mime, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("导出失败：浏览器拒绝编码该格式"))),
      mime,
      mime === "image/png" ? undefined : quality,
    );
  });
}
