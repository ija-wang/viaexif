/* =============================================================================
 * zip.js — minimal STORE-only ZIP writer (no compression, no dependencies).
 * Photo exports are already compressed, so store mode costs ~nothing in size
 * and keeps the container free of third-party bundles.
 * ========================================================================== */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(v) { return [v & 0xff, (v >>> 8) & 0xff]; }
function u32(v) { return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]; }

/** DOS date/time stamp for "now". */
function dosStamp(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * @param {{name: string, data: Uint8Array}[]} files
 * @returns {Blob} application/zip (store mode)
 */
export function zipStore(files) {
  const stamp = dosStamp();
  const encoder = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const crc = crc32(file.data);
    const size = file.data.length;

    const local = new Uint8Array([
      0x50, 0x4b, 0x03, 0x04,
      ...u16(20), ...u16(0x0800), ...u16(0),       // version, UTF-8 flag, store
      ...u16(stamp.time), ...u16(stamp.date),
      ...u32(crc), ...u32(size), ...u32(size),
      ...u16(nameBytes.length), ...u16(0),
      ...nameBytes,
    ]);
    locals.push(local, file.data);

    const central = new Uint8Array([
      0x50, 0x4b, 0x01, 0x02,
      ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0),
      ...u16(stamp.time), ...u16(stamp.date),
      ...u32(crc), ...u32(size), ...u32(size),
      ...u16(nameBytes.length), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(0),
      ...u32(offset),
      ...nameBytes,
    ]);
    centrals.push(central);
    offset += local.length + size;
  }

  const centralSize = centrals.reduce((a, b) => a + b.length, 0);
  const end = new Uint8Array([
    0x50, 0x4b, 0x05, 0x06,
    ...u16(0), ...u16(0),
    ...u16(files.length), ...u16(files.length),
    ...u32(centralSize), ...u32(offset),
    ...u16(0),
  ]);

  return new Blob([...locals, ...centrals, end], { type: "application/zip" });
}

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
