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

/**
 * The face the watermark is set in, for the duration of one render().
 *
 * `null` means the platform stack above, and every call site keeps its own
 * weight. A bundled face is a *specific* weight and slant (the user picks
 * "Thin · 极细", not "weight 500 in Thin"), so when one is selected it
 * overrides the per-call weights — otherwise the browser would synthesise a
 * bold out of a thin master and the picker would look broken.
 *
 * It is set from `opts.fontFace` at the top of render() and put back afterwards
 * rather than being a setting on the module: two renderers given the same
 * options then produce the same pixels no matter what ran before them.
 */
let face = null;

function faceFrom(def) {
  return def && def.family
    ? { family: def.family, weight: def.weight || 400, style: def.style || "normal" }
    : null;
}

function font(size, weight = 500, tracking = 0) {
  const w = face ? face.weight : weight;
  const slant = face && face.style === "italic" ? "italic " : "";
  const family = face ? `"${face.family}", ${FONT_STACK}` : FONT_STACK;
  return { size, weight: w, tracking, css: `${slant}${w} ${Math.max(1, size).toFixed(2)}px ${family}` };
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

/**
 * The shared scratch canvas, sized *exactly* to the mark being tinted.
 *
 * It used to grow-only and clear just the current mark's box. A previous,
 * wider mark therefore stayed alive to the right of that box, and because
 * `drawImage` samples bilinearly the destination's last pixel column reaches
 * one texel past the source rect — so the leftovers came back as a 1px grey
 * rule glued to the mark's right edge. Only the preview showed it: the preview
 * renders at 1200px wide (mark ≈155px, so the box is small) while the export
 * renders full size and its clear happens to cover whatever was left.
 *
 * Resizing resets the bitmap, so nothing can outlive the mark it belonged to.
 */
function scratchOf(w, h) {
  const cw = Math.max(1, Math.ceil(w));
  const ch = Math.max(1, Math.ceil(h));
  if (!scratch) scratch = document.createElement("canvas");
  if (scratch.width !== cw || scratch.height !== ch) {
    scratch.width = cw;
    scratch.height = ch;
  }
  const c = scratch.getContext("2d");
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalCompositeOperation = "source-over";
  c.clearRect(0, 0, cw, ch);
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
 * Is this pixel "neutral ink" — i.e. black/grey with no brand hue?
 *
 * `tint` brands are marks whose ink should follow the template's text colour,
 * because a pure black wordmark vanishes on the dark blur template. Some of
 * them are not monochrome though: Fujifilm's wordmark is black with a red
 * accent on the F. Flattening everything with `source-in` destroyed that red,
 * so only neutral (unsaturated) ink is repainted and brand colour survives.
 */
export function isNeutralInk(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === 0) return true;
  // A *relative* test alone misfires on near-black brand inks: Sony's #231815
  // is 14/255 apart, which reads as 40% "saturation" while looking black. Use
  // the absolute channel spread for dark pixels and the relative one otherwise.
  return max - min <= 24 || (max - min) / max <= 0.22;
}

/** "#111" / "#111111" -> {r,g,b}; anything else falls back to black. */
function parseHex(hex) {
  const s = String(hex || "").trim().replace(/^#/, "");
  const full = s.length === 3 ? s.replace(/./g, (c) => c + c) : s;
  const n = Number.parseInt(full, 16);
  return Number.isFinite(n) && full.length === 6
    ? { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
    : { r: 0, g: 0, b: 0 };
}

/**
 * Repaint a `tint` mark into the scratch canvas: neutral ink takes the text
 * colour, chromatic ink is left untouched.
 */
function tintMark(img, w, h, hex) {
  const cw = Math.max(1, Math.ceil(w));
  const ch = Math.max(1, Math.ceil(h));
  const c = scratchOf(cw, ch);
  c.drawImage(img, 0, 0, w, h);
  const { r, g, b } = parseHex(hex);
  try {
    const data = c.getImageData(0, 0, cw, ch);
    const px = data.data;
    for (let i = 0; i < px.length; i += 4) {
      if (!px[i + 3] || !isNeutralInk(px[i], px[i + 1], px[i + 2])) continue;
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
    }
    c.putImageData(data, 0, 0);
  } catch {
    // Tainted canvas (file:// origin): fall back to a flat silhouette.
    c.globalCompositeOperation = "source-in";
    c.fillStyle = hex;
    c.fillRect(0, 0, cw, ch);
    c.globalCompositeOperation = "source-over";
  }
  return cw;
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
      // repaint the neutral ink in the template's text colour, keep brand hues
      const cw = tintMark(logoImg, w, h, spec.colors.text);
      const ch = Math.max(1, Math.ceil(h));
      // 1:1 copy. Stretching the ceil()ed scratch back into the fractional
      // w/h squeezed its last pixel column into a sub-pixel sliver, which
      // showed up as a grey hairline stuck to the right of the mark.
      ctx.drawImage(scratch, 0, 0, cw, ch, left, y, cw, ch);
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
 * @param {object} opts {template, spec, brand, logoImg, fields, barRatio,
 *   brandRatio, dividerW, radius, barPos, fontFace, quality(scale)}
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

  const outer = face;
  face = faceFrom(opts.fontFace);
  try {
    if (template === "classic") {
      drawClassic(ctx, canvas, image, W, H, opts);
    } else {
      drawBlur(ctx, canvas, image, W, H, opts);
    }
  } finally {
    face = outer;
  }
  return { width: canvas.width, height: canvas.height };
}

/* ------------------------------------------------------------------ classic */
const BAR_SIDES = new Set(["top", "bottom", "left", "right"]);

/** Clamp a caller-supplied side to one the renderer knows. */
export function normalizeBarPos(pos) {
  return BAR_SIDES.has(pos) ? pos : "bottom";
}

/** Which side a photo starts on: landscape frames take the bar underneath,
 *  portrait frames take it on the right where it costs width, not height. */
export function autoBarPos(w, h, table) {
  const t = table || { landscape: "bottom", portrait: "right" };
  return w >= h ? t.landscape : t.portrait;
}

/**
 * Geometry of the classic template, in canvas pixels.
 *
 * The bar is described in *bar space*: a strip of `length × barH` whose origin
 * is the bar's start corner and whose +x runs along the bar, +y across it. A
 * single layout routine draws the strip there, and a translate/rotate per side
 * puts it on the canvas — so "model on the left, params on the right" becomes
 * "model at the bottom, params at the top" on a side bar for free, with no
 * second layout path to drift out of sync.
 *
 * Side bars rotate counter-clockwise, i.e. their text reads bottom-to-top: the
 * caption starts at the photo's bottom edge on all four sides, which is what
 * makes a left and a right bar look like mirror images of each other instead of
 * one of them being upside down.
 */
export function barGeometry(W, H, barH, pos) {
  const side = normalizeBarPos(pos);
  const vertical = side === "left" || side === "right";
  const canvasW = vertical ? W + barH : W;
  const canvasH = vertical ? H : H + barH;
  const photo = {
    top: { x: 0, y: barH },
    bottom: { x: 0, y: 0 },
    left: { x: barH, y: 0 },
    right: { x: 0, y: 0 },
  }[side];
  const origin = {
    top: { x: 0, y: 0 },
    bottom: { x: 0, y: H },
    left: { x: 0, y: H },
    right: { x: W, y: H },
  }[side];
  return {
    side,
    vertical,
    canvasW,
    canvasH,
    photo: { x: photo.x, y: photo.y, w: W, h: H },
    origin,
    length: vertical ? H : W,
  };
}

function drawClassic(ctx, canvas, image, W, H, opts) {
  const { spec } = opts;
  const L = spec.layout;
  const C = spec.colors;
  const barH = Math.max(12, Math.round(W * opts.barRatio));
  const g = barGeometry(W, H, barH, opts.barPos);

  canvas.width = g.canvasW;
  canvas.height = g.canvasH;

  // Bar colour first, as a full-canvas fill: the bar is one rectangle and the
  // photo covers the rest, so a side bar needs no separate rect bookkeeping.
  ctx.fillStyle = C.bar;
  ctx.fillRect(0, 0, g.canvasW, g.canvasH);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, g.photo.x, g.photo.y, g.photo.w, g.photo.h);

  // A side bar is as thick as the bottom bar is tall, and its inset follows the
  // thickness instead of the length — a 4000px-tall frame would otherwise push
  // the caption hundreds of pixels into the strip.
  const padX = g.vertical ? barH * (L.sidePadRatio ?? 0.28) : g.length * L.barPadX;

  ctx.save();
  ctx.translate(g.origin.x, g.origin.y);
  if (g.vertical) ctx.rotate(-Math.PI / 2);
  drawBar(ctx, opts, g.length, barH, padX, W);
  ctx.restore();
}

/** Draw the caption inside bar space: (0,0) is the strip's start corner. */
function drawBar(ctx, opts, Lb, barH, padX, refW) {
  const { spec, brand, fields } = opts;
  const L = spec.layout;
  const C = spec.colors;
  const params = fields.params;
  const cy = barH / 2;
  const gap = barH * L.gap;
  // The rule between the brand mark and the params: a slider ratio of the
  // *photo* width, 2px at the 1200px reference width. It is deliberately not a
  // hairline — at 1px the stroke lands half-on-half-off a pixel column, greys
  // itself out, and reads as a smudge stuck to the mark instead of a separator.
  const divW = opts.dividerW != null ? opts.dividerW * refW : refW * (L.dividerW || 2 / 1200);

  // ---- 1) size the right block first, capped at 58% of the strip length
  let paramF = font(barH * L.paramFont, 500);
  let markH = barH * L.brandFont * (opts.brandRatio / 0.3);
  const rightCap = Lb * 0.58;
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
  const leftAvail = Math.max(Lb * 0.18, Lb - 2 * padX - rightW - gutter);
  const modelF = fitFont(ctx, fields.model, font(barH * L.modelFont, 600), leftAvail);
  const dateF = fitFont(ctx, fields.shotAt, font(barH * L.dateFont, 500), leftAvail);

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = C.text;
  setFont(ctx, modelF);
  if (fields.model) ctx.fillText(fields.model, padX, barH * L.modelBaseline);
  ctx.fillStyle = C.sub;
  setFont(ctx, dateF);
  if (fields.shotAt) ctx.fillText(fields.shotAt, padX, barH * L.dateBaseline);

  // ---- 3) draw the right block: [brand logo] [divider] [params]
  {
    const rightX = Lb - padX;
    const pw = measure(ctx, params, paramF);
    const paramLeft = rightX - pw;

    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillStyle = C.text;
    setFont(ctx, paramF);
    if (params) ctx.fillText(params, rightX, cy);

    if (brand) {
      const divX = paramLeft - gap - divW;
      if (divW > 0) {
        const divH = barH * L.dividerH;
        ctx.fillStyle = C.divider;
        ctx.fillRect(divX, cy - divH / 2, divW, divH);
      }

      drawBrandMark(ctx, opts, divX - gap, cy - markH / 2, markH, "right");
    }
  }
  ctx.textBaseline = "alphabetic";
}

/* --------------------------------------------------------------------- blur */
/**
 * Geometry of the blur template, in canvas pixels.
 *
 * The inset keeps the photo's own aspect ratio: its height is derived from its
 * width, and the canvas grows/shrinks by the fixed text strip at the bottom.
 * The old code did the opposite — it hardcoded the inset height from `H` and
 * then cover-cropped the photo into that box, which silently cut ~8% off the
 * top and bottom of a 3:2 frame (and ~4% off the sides of a 2:3 frame).
 *
 * `radiusRatio` is the optional corner-radius slider (ratio of `W`). It
 * defaults to 0: a rounded corner clips real pixels out of the frame corners,
 * so it is opt-in rather than baked into the layout.
 *
 * The text block is 2 or 3 lines — [logo] model / params / timestamp. The
 * timestamp is optional because a photo without EXIF date has nothing to show
 * there, and reserving an empty line would leave the caption floating away from
 * the frame. `line3Y` is only meaningful when `hasDate`.
 */
export function blurLayout(W, H, L, radiusRatio, hasDate = true) {
  const padX = W * L.padX;
  const padTop = W * L.padTop;
  const textSize = W * L.textFont;
  const lines = hasDate ? 3 : 2;
  const bottomStrip = W * L.line2Baseline + textSize * (1 + L.lineGap * (lines - 1) + L.photoGapAboveText);
  const photoW = W - padX * 2;
  const photoH = Math.max(1, photoW * (H / W));
  const canvasH = Math.round(padTop + photoH + bottomStrip);
  const rr = radiusRatio ?? L.radius ?? 0;
  const line3Y = canvasH - W * L.line2Baseline;
  const line2Y = line3Y - (hasDate ? textSize * L.lineGap : 0);
  return {
    padX,
    padTop,
    photoW,
    photoH,
    canvasH,
    radius: Math.max(0, W * rr),
    textSize,
    line3Y,
    line2Y,
    line1Y: line2Y - textSize * L.lineGap,
  };
}

function drawBlur(ctx, canvas, image, W, H, opts) {
  const { spec, brand, fields } = opts;
  const L = spec.layout;
  const C = spec.colors;
  const hasDate = Boolean((fields.shotAt || "").trim());
  const g = blurLayout(W, H, L, opts.radius, hasDate);

  canvas.width = W;
  canvas.height = g.canvasH;

  // ---- background: the same photo, cover-fitted, blurred, slightly darkened
  ctx.save();
  if ("filter" in ctx) ctx.filter = `blur(${Math.max(6, Math.round(W * L.bgBlur))}px)`;
  const cover = coverRect(W, g.canvasH, W, H);
  ctx.drawImage(image, cover.x, cover.y, cover.w, cover.h);
  ctx.restore();

  if ("filter" in ctx) ctx.filter = "none";
  ctx.fillStyle = `rgba(0,0,0,${L.bgDarken})`;
  ctx.fillRect(0, 0, W, g.canvasH);

  // ---- inset photo: the whole frame, aspect untouched (no crop).
  // Corners are square by default — clipping a radius out of the frame throws
  // away pixels that were actually photographed, so it is an opt-in slider.
  const { padX, padTop, photoW, photoH, radius } = g;
  if (radius > 0) {
    ctx.save();
    roundRectPath(ctx, padX, padTop, photoW, photoH, radius);
    ctx.clip();
    ctx.drawImage(image, padX, padTop, photoW, photoH);
    ctx.restore();
  } else {
    ctx.drawImage(image, padX, padTop, photoW, photoH);
  }

  // ---- text line 1: [Brand logo] [Model], centred
  const textF = font(g.textSize, 500);
  const { line1Y, line2Y, line3Y } = g;
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

  // ---- text line 3: the timestamp, centred under the exposure line and set at
  // the same size as it — a watermark reads as one block of type, so the date
  // is distinguished by its dimmer colour, not by a different point size.
  if (fields.shotAt) {
    const dateF = fitFont(ctx, fields.shotAt, font(textF.size, 500, textF.tracking), maxLine);
    ctx.textAlign = "center";
    ctx.fillStyle = C.sub;
    setFont(ctx, dateF);
    ctx.fillText(fields.shotAt, W / 2, line3Y);
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
