/* =============================================================================
 * formats.js — what did the user just drop on us?
 *
 * Browsers lie about File.type for camera files (HEIC often arrives as "",
 * RAW always does), so routing decisions are made from magic bytes, with the
 * extension only as a fallback.
 * ========================================================================== */

export const NATIVE_KINDS = new Set(["jpeg", "png", "webp"]);

const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"]);
const AVIF_BRANDS = new Set(["avif", "avis"]);

const EXT_KIND = {
  jpg: "jpeg", jpeg: "jpeg", png: "png", webp: "webp",
  heic: "heic", heif: "heic", avif: "avif",
  tif: "tiff", tiff: "tiff",
  dng: "raw", cr2: "raw", cr3: "raw", crw: "raw", nef: "raw", nrw: "raw",
  arw: "raw", srf: "raw", sr2: "raw", raf: "raw", orf: "raw", rw2: "raw",
  raw: "raw", pef: "raw", srw: "raw", "3fr": "raw", fff: "raw", iiq: "raw",
  mos: "raw", mrw: "raw", x3f: "raw", dcr: "raw", kdc: "raw", erf: "raw",
  mef: "raw", rwl: "raw",
};

const KIND_LABEL = {
  jpeg: "JPEG", png: "PNG", webp: "WEBP", heic: "HEIC", avif: "AVIF",
  tiff: "TIFF", raw: "RAW",
};

const ascii = (bytes, from, to) => String.fromCharCode(...bytes.subarray(from, to));

/** @returns {{kind: string, label: string}|null} */
export function sniffBytes(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (b.length < 16) return null;

  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return hit("jpeg");
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return hit("png");
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45 && b[11] === 0x50) return hit("webp");

  if (ascii(b, 4, 8) === "ftyp") {
    const brand = ascii(b, 8, 12).trim();
    if (HEIC_BRANDS.has(brand)) return hit("heic");
    if (AVIF_BRANDS.has(brand)) return hit("avif");
    if (brand === "crx") return hit("raw", "Canon CR3");
  }

  const magic = ascii(b, 0, 4);
  if (magic === "II*\u0000" || magic === "MM\u0000*") return hit("tiff");
  if (ascii(b, 0, 15) === "FUJIFILMCCD-RAW") return hit("raw", "Fujifilm RAF");
  if (magic === "FOVb") return hit("raw", "Sigma X3F");
  if (magic === "IIRO" || magic === "MMOR") return hit("raw", "Olympus ORF");
  if (magic === "IIII") return hit("raw", "Phase One IIQ");
  if (b[0] === 0x00 && ascii(b, 1, 4) === "MRM") return hit("raw", "Minolta MRW");
  return null;

  function hit(kind, label) {
    return { kind, label: label || KIND_LABEL[kind] || kind.toUpperCase() };
  }
}

export function extOf(name = "") {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}

export function kindFromName(name) {
  return EXT_KIND[extOf(name)] || null;
}

export function isNative(kind) {
  return NATIVE_KINDS.has(kind);
}

export function isLiveVideo(name) {
  return /\.(mov|qt)$/i.test(name);
}

export function stemOf(name = "") {
  return name.replace(/\.[^.]+$/, "").toUpperCase();
}

/** 8.2 MB — used in the queue chips. */
export function humanSize(bytes) {
  if (!bytes) return "0 MB";
  const mb = bytes / 1024 / 1024;
  return mb >= 10 ? `${mb.toFixed(0)} MB` : `${mb.toFixed(1)} MB`;
}
