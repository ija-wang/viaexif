/* Node-side unit tests for the browser modules (no DOM needed).
 * Run: bash tests/run.sh
 * exif.js / zip.js are copied to .tmp/*.mjs so Node treats them as ESM.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(here, ".tmp");
const modUrl = (name) => pathToFileURL(path.join(tmp, name)).href;

const { readExif, toFields, formatShutter, formatAperture, guessBrand } = await import(modUrl("exif.mjs"));
const { zipStore } = await import(modUrl("zip.mjs"));
const { sniffBytes, kindFromName, isNative, isLiveVideo, stemOf } = await import(modUrl("formats.mjs"));
const { parseMov } = await import(modUrl("live.mjs"));
const { blurLayout, isNeutralInk } = await import(modUrl("render.mjs"));

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}\n       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`);
  }
}

const HINTS = [
  ["fujifilm", "fujifilm"], ["canon", "canon"], ["nikon", "nikon"], ["sony", "sony"],
  ["apple", "apple"], ["eos", "canon"], ["ilce", "sony"], ["x-t", "fujifilm"],
];

console.log("readExif");
for (const name of ["sample.jpg", "sample.png", "sample.webp"]) {
  const buf = await readFile(path.join(here, "fixtures", name));
  const exif = readExif(new Uint8Array(buf));
  check(`${name} make`, exif.make, "FUJIFILM");
  check(`${name} model`, exif.model, "X-T4");
  check(`${name} focal`, exif.focal, 53);
  check(`${name} fNumber`, exif.fNumber, 3.2);
  check(`${name} exposure`, Math.round(1 / exif.exposure), 5800);
  check(`${name} iso`, exif.iso, 640);
  check(`${name} brand`, guessBrand(exif, HINTS), "fujifilm");
}

const plain = readExif(new Uint8Array(await readFile(path.join(here, "fixtures", "no-exif.jpg"))));
check("no-exif returns empty object", plain, {});

console.log("formatters");
check("shutter 1/5800", formatShutter(1 / 5800), "1/5800s");
check("shutter 2s", formatShutter(2), "2s");
check("shutter 1/125", formatShutter(1 / 125), "1/125s");
check("aperture 3.2", formatAperture(3.2), "f/3.2");
check("aperture 2.0", formatAperture(2.0), "f/2");
check("aperture 11", formatAperture(11), "f/11");

const fields = toFields({
  model: "X-T4", focal: 53, fNumber: 3.2, exposure: 1 / 5800, iso: 640,
  dateTime: "2024:05:16 12:33:44",
});
check("toFields", fields, {
  model: "X-T4", focal: "53mm", aperture: "f/3.2", shutter: "1/5800s", iso: "ISO640",
  shotAt: "2024-05-16 12:33",
});

console.log("formats.sniffBytes");
{
  const cases = [
    ["sample.jpg", "jpeg", true],
    ["sample.png", "png", true],
    ["sample.webp", "webp", true],
    ["sample.heic", "heic", false],
    ["synthetic.dng", "tiff", false],
  ];
  for (const [name, kind, native] of cases) {
    const buf = new Uint8Array(await readFile(path.join(here, "fixtures", name)));
    const hit = sniffBytes(buf.subarray(0, 64));
    check(`${name} sniffed as ${kind}`, hit?.kind, kind);
    check(`${name} native=${native}`, isNative(hit?.kind), native);
  }
  // camera files often arrive with an empty MIME type; the extension decides
  check("CR3 by extension", kindFromName("_MG_0421.CR3"), "raw");
  check("NEF by extension", kindFromName("DSC_0042.nef"), "raw");
  check("unknown extension", kindFromName("notes.txt"), null);
  check("live video detection", isLiveVideo("IMG_0001.MOV"), true);
  check("photo is not a video", isLiveVideo("IMG_0001.HEIC"), false);
  check("stem pairs heic+mov", stemOf("IMG_0001.HEIC") === stemOf("IMG_0001.MOV"), true);
}

console.log("live.parseMov");
{
  const mov = new Uint8Array(await readFile(path.join(here, "fixtures", "live", "IMG_0001.MOV")));
  const info = parseMov(mov);
  check("live photo detected", info.isLive, true);
  check("content identifier", info.contentId, "C4A1F0E2-9B77-4C33-8A1D-2F5B7E9C0D31");
  check("duration from mvhd", Math.round(info.duration * 10) / 10, 3.2);
  check("still-image-time marker", info.stillTime, 0);
  const notMov = parseMov(new Uint8Array(await readFile(path.join(here, "fixtures", "sample.jpg"))));
  check("jpeg is not a live photo", notMov.isLive, false);
}

console.log("blurLayout");
// Layout ratios mirrored from server/config.py SPEC.blur.layout.
const BLUR_L = {
  padX: 0.062, padTop: 0.030, radius: 0, bgBlur: 0.020, bgDarken: 0.22,
  textFont: 0.0165, line2Baseline: 0.036, lineGap: 1.350, brandFont: 1.150,
  brandGap: 0.550, photoGapAboveText: 1.600,
};
const ratio4 = (w, h) => Math.round((w / h) * 10000) / 10000;
{
  const g = blurLayout(1200, 800, BLUR_L, 0, false); // 3:2 landscape, no date line
  const d = blurLayout(1200, 800, BLUR_L, 0, true);  // ...and with the timestamp
  check("3:2 inset keeps source ratio", ratio4(g.photoW, g.photoH), 1.5);
  check("inset spans the padded width", Math.round(g.photoW), 1051);
  check("canvas grows instead of cropping", g.canvasH, 858);
  check("canvas grows by one line for the timestamp", d.canvasH, 885);
  check("the timestamp line sits below the params", d.line3Y > d.line2Y && d.line2Y > d.line1Y, true);
  check("no timestamp, no reserved line", g.line3Y === g.line2Y, true);
  check("canvas keeps padTop above the photo", Math.round(g.padTop), 36);
}
{
  const g = blurLayout(1200, 1800, BLUR_L);          // 2:3 portrait
  check("2:3 inset keeps source ratio", ratio4(g.photoW, g.photoH), 0.6667);
  check("portrait canvas follows the photo", g.canvasH, 1761);
}
{
  const g = blurLayout(1200, 1200, BLUR_L);          // square
  check("1:1 inset keeps source ratio", ratio4(g.photoW, g.photoH), 1);
}
{
  // Whatever the source, the inset must never be cropped: width-driven height.
  const sizes = [[4000, 3000], [3000, 4000], [8000, 1000], [1000, 3000]];
  check(
    "no crop for any aspect",
    sizes.every(([w, h]) => Math.abs(blurLayout(w, h, BLUR_L).photoW / blurLayout(w, h, BLUR_L).photoH - w / h) < 1e-9),
    true,
  );
}
{
  // Corners are square unless the slider explicitly asks for a radius: a
  // rounded corner clips photographed pixels away from the frame.
  check("radius defaults to 0 (no corner clipping)", blurLayout(1200, 800, BLUR_L).radius, 0);
  check("radius slider is honoured", Math.round(blurLayout(1200, 800, BLUR_L, 0.05).radius), 60);
  check("radius scales with the frame", Math.round(blurLayout(2400, 1600, BLUR_L, 0.05).radius), 120);
  check("negative radius is clamped", blurLayout(1200, 800, BLUR_L, -0.5).radius, 0);
}

console.log("brand ink");
// tint brands keep their brand colour: only neutral ink is repainted.
check("pure black is neutral ink", isNeutralInk(0, 0, 0), true);
check("light grey is neutral ink", isNeutralInk(200, 200, 200), true);
check("fujifilm red survives tinting", isNeutralInk(0xed, 0x1a, 0x3a), false);
check("canon red survives tinting", isNeutralInk(0xcc, 0x22, 0x29), false);
// Near-black brand inks are the trap: relative saturation reads as 40% colour
// for Sony's #231815, so the test must go by absolute channel spread down there.
check("sony near-black ink is neutral", isNeutralInk(0x23, 0x18, 0x15), true);
check("gopro charcoal ink is neutral", isNeutralInk(0x2c, 0x2c, 0x2c), true);
check("nikon yellow is not neutral", isNeutralInk(0xff, 0xe1, 0x00), false);
check("huawei red is not neutral", isNeutralInk(0xc7, 0x1f, 0x1e), false);

console.log("zipStore");
const payload = new TextEncoder().encode("hello viaexif");
const blob = zipStore([{ name: "a.txt", data: payload }]);
const zipBytes = new Uint8Array(await blob.arrayBuffer());
await mkdir(tmp, { recursive: true });
await writeFile(path.join(tmp, "out.zip"), zipBytes);
check("zip signature", Array.from(zipBytes.slice(0, 4)), [0x50, 0x4b, 0x03, 0x04]);
check("zip non-empty", zipBytes.length > payload.length + 60, true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
