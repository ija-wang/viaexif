/* =============================================================================
 * live.js — Apple Live Photo companion (.MOV) reader.
 *
 * A Live Photo is a HEIC still + a MOV that share one metadata key:
 * com.apple.quicktime.content.identifier. We read that pair from the MOV side,
 * plus the still-image-time marker that tells the player where the photo sits
 * on the video timeline, so the UI can label the pair honestly.
 * ========================================================================== */

const KEY_LIVE = "com.apple.quicktime.content.identifier";
const KEY_STILL = "com.apple.quicktime.still-image-time";

export async function readLiveVideo(file) {
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    return { file, name: file.name, size: file.size, ...parseMov(buf) };
  } catch (err) {
    console.warn("[live] parse failed", err);
    return { file, name: file.name, size: file.size, isLive: false, contentId: null, duration: 0 };
  }
}

export function parseMov(buf) {
  const out = { isLive: false, contentId: null, duration: 0, stillTime: null };
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const moov = findBox(buf, view, 0, buf.length, "moov");
  if (!moov) return out;

  const mvhd = findBox(buf, view, moov.body, moov.end, "mvhd");
  if (mvhd) {
    const version = buf[mvhd.body];
    const timescale = version === 1 ? view.getUint32(mvhd.body + 20) : view.getUint32(mvhd.body + 12);
    const duration = version === 1
      ? Number(view.getBigUint64(mvhd.body + 24))
      : view.getUint32(mvhd.body + 16);
    if (timescale) out.duration = duration / timescale;
  }

  const meta = findBox(buf, view, moov.body, moov.end, "meta");
  if (!meta) return out;
  // `meta` is a full box: 1 byte version + 3 bytes flags before its children.
  const start = meta.body + 4;
  const keys = readKeys(buf, view, start, meta.end);
  const ilst = findBox(buf, view, start, meta.end, "ilst");
  if (!ilst || !keys.length) return out;

  for (const item of eachBox(buf, view, ilst.body, ilst.end)) {
    if (item.type === "free" || item.type === "meta") continue;
    const index = view.getUint32(item.body);
    const key = keys[index - 1];
    if (!key) continue;
    const data = findBox(buf, view, item.body + 4, item.end, "data");
    if (!data) continue;
    const value = readDataValue(buf, view, data);
    if (key === KEY_LIVE && typeof value === "string") out.contentId = value;
    if (key === KEY_STILL) out.stillTime = typeof value === "number" ? value : 0;
  }

  out.isLive = Boolean(out.contentId) || out.stillTime !== null;
  return out;
}

function readKeys(buf, view, start, end) {
  const box = findBox(buf, view, start, end, "keys");
  if (!box) return [];
  const count = view.getUint32(box.body + 4);
  const keys = [];
  let ptr = box.body + 8;
  for (let i = 0; i < count && ptr + 8 <= box.end; i += 1) {
    const size = view.getUint32(ptr);
    if (size < 8 || ptr + size > box.end) break;
    keys.push(decodeText(buf.subarray(ptr + 8, ptr + size)));
    ptr += size;
  }
  return keys;
}

function readDataValue(buf, view, data) {
  const type = view.getUint32(data.body) & 0xffffff;
  const valueStart = data.body + 8;
  if (valueStart >= data.end) return null;
  if (type === 1) return decodeText(buf.subarray(valueStart, data.end));
  if (type === 21) return view.getInt32(valueStart);
  if (type === 22) return view.getUint32(valueStart);
  if (type === 23) return view.getFloat32(valueStart);
  return null;
}

function decodeText(bytes) {
  try {
    return new TextDecoder("utf-8").decode(bytes).replace(/\0+$/, "").trim();
  } catch {
    return "";
  }
}

function eachBox(buf, view, start, end) {
  const boxes = [];
  let ptr = start;
  while (ptr + 8 <= end) {
    let size = view.getUint32(ptr);
    const type = String.fromCharCode(buf[ptr + 4], buf[ptr + 5], buf[ptr + 6], buf[ptr + 7]);
    if (size === 1) {
      if (ptr + 16 > end) break;
      size = Number(view.getBigUint64(ptr + 8));
      if (!size) break;
      boxes.push({ type, start: ptr, body: ptr + 16, end: ptr + size });
      ptr += size;
      continue;
    }
    if (size === 0) {
      boxes.push({ type, start: ptr, body: ptr + 8, end });
      break;
    }
    if (size < 8 || ptr + size > end) break;
    boxes.push({ type, start: ptr, body: ptr + 8, end: ptr + size });
    ptr += size;
  }
  return boxes;
}

function findBox(buf, view, start, end, type) {
  return eachBox(buf, view, start, end).find((b) => b.type === type) || null;
}
