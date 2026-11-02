/* =============================================================================
 * exif.js — dependency-free EXIF reader.
 *
 * Supports the three containers the tool accepts:
 *   JPEG  -> APP1 segment starting with "Exif\0\0"
 *   PNG   -> eXIf chunk
 *   WebP  -> EXIF chunk (RIFF)
 * All three carry the same TIFF/IFD payload, so one parser covers them.
 * ========================================================================== */

const TAG = {
  MAKE: 0x010f,
  MODEL: 0x0110,
  ORIENTATION: 0x0112,
  DATETIME: 0x0132,
  EXIF_IFD: 0x8769,
  EXPOSURE_TIME: 0x829a,
  F_NUMBER: 0x829d,
  ISO: 0x8827,
  ISO_SPEED: 0x8833,
  DATETIME_ORIGINAL: 0x9003,
  FOCAL_LENGTH: 0x920a,
  PIXEL_X: 0xa002,
  PIXEL_Y: 0xa003,
  LENS_MODEL: 0xa434,
};

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

/* ------------------------------------------------------------------ public */

/**
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {object} normalized metadata (all fields optional)
 */
export function readExif(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const block = locateExifBlock(view, bytes);
  if (!block) return {};

  try {
    return parseTiff(view, block.start, block.length);
  } catch (err) {
    console.warn("[exif] parse failed", err);
    return {};
  }
}

export function formatFocal(mm) {
  if (!isFinite(mm) || mm <= 0) return "";
  return `${Math.round(mm)}mm`;
}

export function formatAperture(f) {
  if (!isFinite(f) || f <= 0) return "";
  const rounded = Math.round(f * 10) / 10;
  return `f/${String(rounded).replace(/\.0$/, "")}`;
}

export function formatShutter(seconds) {
  if (!isFinite(seconds) || seconds <= 0) return "";
  if (seconds >= 1) {
    const r = Math.round(seconds * 10) / 10;
    return `${String(r).replace(/\.0$/, "")}s`;
  }
  const denom = Math.round(1 / seconds);
  // Snap to the 1/3-stop ladder when the file stores a rounded value.
  const ladder = [8000, 6400, 5000, 4000, 3200, 2500, 2000, 1600, 1250, 1000, 800, 640,
    500, 400, 320, 250, 200, 160, 125, 100, 80, 60, 50, 40, 30, 25, 20, 15, 13, 10,
    8, 6, 5, 4, 3, 2];
  const near = ladder.find((v) => Math.abs(v - denom) / v < 0.06);
  return `1/${near ?? denom}s`;
}

export function formatIso(iso) {
  const n = Math.round(Number(iso));
  return isFinite(n) && n > 0 ? `ISO${n}` : "";
}

export function formatDateTime(raw) {
  if (!raw || typeof raw !== "string") return "";
  // EXIF style: "2024:05:16 12:33:44"
  const m = raw.match(/^(\d{4})[:\-](\d{2})[:\-](\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return raw.trim();
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
}

/** Map normalized exif -> the 6 editable text fields of the tool. */
export function toFields(exif) {
  return {
    model: exif.model || "",
    focal: formatFocal(exif.focal),
    aperture: formatAperture(exif.fNumber),
    shutter: formatShutter(exif.exposure),
    iso: formatIso(exif.iso),
    shotAt: formatDateTime(exif.dateTime),
  };
}

/* ------------------------------------------------------------- container */

function locateExifBlock(view, bytes) {
  if (bytes.length < 12) return null;

  // ---- JPEG
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 4 <= bytes.length) {
      if (bytes[i] !== 0xff) { i += 1; continue; }
      const marker = bytes[i + 1];
      if (marker === 0xff) { i += 1; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      if (marker === 0xda || marker === 0xd9) break; // start of scan / end
      const len = view.getUint16(i + 2);
      if (len < 2) break;
      const payload = i + 4;
      if (marker === 0xe1 && payload + 6 <= bytes.length &&
          bytes[payload] === 0x45 && bytes[payload + 1] === 0x78 &&
          bytes[payload + 2] === 0x69 && bytes[payload + 3] === 0x66 &&
          bytes[payload + 4] === 0x00 && bytes[payload + 5] === 0x00) {
        return { start: payload + 6, length: i + 2 + len - (payload + 6) };
      }
      i += 2 + len;
    }
    return null;
  }

  // ---- PNG
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    let i = 8;
    while (i + 8 <= bytes.length) {
      const len = view.getUint32(i);
      const type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
      if (type === "eXIf") return { start: i + 8, length: len };
      if (type === "IEND") break;
      i += 12 + len;
    }
    return null;
  }

  // ---- WebP
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    let i = 12;
    while (i + 8 <= bytes.length) {
      const size = view.getUint32(i + 4, true);
      const fourcc = String.fromCharCode(bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]);
      if (fourcc === "EXIF") {
        const payload = i + 8;
        const hasPrefix = bytes[payload] === 0x45 && bytes[payload + 1] === 0x78 &&
          bytes[payload + 2] === 0x69 && bytes[payload + 3] === 0x66;
        return { start: payload + (hasPrefix ? 6 : 0), length: size - (hasPrefix ? 6 : 0) };
      }
      i += 8 + size + (size % 2);
    }
    return null;
  }

  return null;
}

/* ------------------------------------------------------------------- tiff */

function parseTiff(view, start, length) {
  if (start + 8 > view.byteLength) return {};
  const byteOrder = view.getUint16(start);
  if (byteOrder !== 0x4949 && byteOrder !== 0x4d4d) return {};
  const le = byteOrder === 0x4949;
  if (view.getUint16(start + 2, le) !== 42) return {};

  const ifd0 = readIfd(view, start, view.getUint32(start + 4, le), le);
  const out = {
    make: ascii(ifd0[TAG.MAKE]),
    model: ascii(ifd0[TAG.MODEL]),
    dateTime: ascii(ifd0[TAG.DATETIME]),
    orientation: Number(ifd0[TAG.ORIENTATION] ?? 1) || 1,
  };

  if (ifd0[TAG.EXIF_IFD]) {
    const exif = readIfd(view, start, Number(ifd0[TAG.EXIF_IFD]), le);
    out.exposure = rational(exif[TAG.EXPOSURE_TIME]);
    out.fNumber = rational(exif[TAG.F_NUMBER]);
    out.iso = Number(exif[TAG.ISO] ?? exif[TAG.ISO_SPEED] ?? 0) || undefined;
    out.focal = rational(exif[TAG.FOCAL_LENGTH]);
    out.dateTime = ascii(exif[TAG.DATETIME_ORIGINAL]) || out.dateTime;
    out.lens = ascii(exif[TAG.LENS_MODEL]);
    out.pixelWidth = Number(exif[TAG.PIXEL_X] ?? 0) || undefined;
    out.pixelHeight = Number(exif[TAG.PIXEL_Y] ?? 0) || undefined;
  }
  return out;
}

function readIfd(view, tiffStart, offset, le) {
  const out = {};
  const base = tiffStart + offset;
  if (offset <= 0 || base + 2 > view.byteLength) return out;
  const count = view.getUint16(base, le);
  if (count > 512) return out; // corrupt guard

  for (let i = 0; i < count; i += 1) {
    const entry = base + 2 + i * 12;
    if (entry + 12 > view.byteLength) break;
    const tag = view.getUint16(entry, le);
    const type = view.getUint16(entry + 2, le);
    const num = view.getUint32(entry + 4, le);
    out[tag] = readValue(view, tiffStart, entry + 8, type, num, le);
  }
  return out;
}

function readValue(view, tiffStart, valueOffset, type, num, le) {
  const size = TYPE_SIZE[type];
  if (!size || num > 4096) return undefined;
  const total = size * num;
  let ptr = valueOffset;
  if (total > 4) {
    const off = view.getUint32(valueOffset, le);
    ptr = tiffStart + off;
  }
  if (ptr + total > view.byteLength) return undefined;

  if (type === 2) {
    let s = "";
    for (let i = 0; i < total; i += 1) {
      const c = view.getUint8(ptr + i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }
  if (type === 5 || type === 10) {
    const pairs = [];
    for (let i = 0; i < num; i += 1) {
      const n = type === 5 ? view.getUint32(ptr + i * 8, le) : view.getInt32(ptr + i * 8, le);
      const d = type === 5 ? view.getUint32(ptr + i * 8 + 4, le) : view.getInt32(ptr + i * 8 + 4, le);
      pairs.push(d === 0 ? 0 : n / d);
    }
    return num === 1 ? pairs[0] : pairs;
  }
  const values = [];
  for (let i = 0; i < num; i += 1) {
    const p = ptr + i * size;
    switch (type) {
      case 1: values.push(view.getUint8(p)); break;
      case 3: values.push(view.getUint16(p, le)); break;
      case 4: values.push(view.getUint32(p, le)); break;
      case 6: values.push(view.getInt8(p)); break;
      case 8: values.push(view.getInt16(p, le)); break;
      case 9: values.push(view.getInt32(p, le)); break;
      case 11: values.push(view.getFloat32(p, le)); break;
      case 12: values.push(view.getFloat64(p, le)); break;
      default: values.push(undefined);
    }
  }
  return num === 1 ? values[0] : values;
}

function ascii(v) {
  if (typeof v !== "string") return "";
  return v.replace(/\0+$/, "").trim();
}

function rational(v) {
  if (typeof v === "number") return v;
  if (Array.isArray(v)) return v[0];
  return undefined;
}

/* ---------------------------------------------------------------- brands */

/** Guess a brand key from Make/Model strings using the server-provided hints. */
export function guessBrand(exif, hints) {
  const hay = `${exif.make || ""} ${exif.model || ""}`.toLowerCase();
  if (!hay.trim()) return null;
  for (const [needle, key] of hints) {
    if (hay.includes(needle)) return key;
  }
  return null;
}
