/**
 * Generates IBC Contracts.icns from nothing but node:zlib.
 *
 * WHY draw it in code instead of committing a binary: the installer assembles
 * the .app on her Mac, and a committed .icns is one more binary blob to keep in
 * sync with the design tokens. This file is the source of truth for the mark,
 * and it has no dependencies, so the installer can regenerate the icon with the
 * runtime it just downloaded.
 *
 * Rendering is signed-distance-field coverage rather than supersampling, so
 * every size in the iconset is drawn natively at its own resolution. That keeps
 * the 16px variant crisp instead of a mushy downsample of the 1024px one.
 *
 * Usage: node scripts/make-icon.mjs <output.icns>
 */

import { deflateSync } from 'node:zlib';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

// Design grid. Every coordinate below is on a 1024x1024 canvas and scaled down
// per size, which is how the macOS icon grid is specified.
const GRID = 1024;

// Pulled from src/app/globals.css so the icon and the app agree on blue.
const ACCENT_TOP = [0x1c, 0x84, 0xf0];
const ACCENT_BOTTOM = [0x00, 0x63, 0xc8];
const PAPER = [0xff, 0xff, 0xff];
const RULE = [0xb9, 0xc6, 0xd4];
const MARK = [0x00, 0x71, 0xe3];

// --- signed distance fields ------------------------------------------------
// Negative inside, positive outside, measured in canvas units.

function sdRoundedRect(px, py, cx, cy, halfW, halfH, r) {
  const qx = Math.abs(px - cx) - (halfW - r);
  const qy = Math.abs(py - cy) - (halfH - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Capsule: the segment ab grown by `r`. Used for both rules and the check. */
function sdSegment(px, py, ax, ay, bx, by, r) {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const denom = bax * bax + bay * bay;
  const raw = denom === 0 ? 0 : (pax * bax + pay * bay) / denom;
  const h = Math.min(Math.max(raw, 0), 1);
  const dx = pax - bax * h;
  const dy = pay - bay * h;
  return Math.sqrt(dx * dx + dy * dy) - r;
}

/**
 * Distance to coverage. The 0.5 offset centres the transition on the shape
 * edge; `unit` is one output pixel expressed in canvas units, so the ramp is
 * always exactly one device pixel wide whatever size we are drawing.
 */
function coverage(d, unit) {
  return Math.min(Math.max(0.5 - d / unit, 0), 1);
}

// --- compositing -----------------------------------------------------------

function over(buf, i, rgb, a) {
  if (a <= 0) return;
  const dstA = buf[i + 3] / 255;
  const outA = a + dstA * (1 - a);
  if (outA <= 0) return;
  for (let c = 0; c < 3; c += 1) {
    const dst = buf[i + c] / 255;
    buf[i + c] = Math.round(((rgb[c] / 255) * a + dst * dstA * (1 - a)) / outA * 255);
  }
  buf[i + 3] = Math.round(outA * 255);
}

function lerp(a, b, t) {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

function render(size) {
  const buf = new Uint8Array(size * size * 4);
  const unit = GRID / size; // one output pixel, in canvas units
  const half = unit / 2;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      // Sample at the pixel centre.
      const px = x * unit + half;
      const py = y * unit + half;
      const i = (y * size + x) * 4;

      // 1. The rounded square. Inset to the standard macOS art box so the icon
      //    sits at the same optical size as everything else in the Dock.
      const dBg = sdRoundedRect(px, py, 512, 512, 412, 412, 184);
      const aBg = coverage(dBg, unit);
      if (aBg > 0) {
        over(buf, i, lerp(ACCENT_TOP, ACCENT_BOTTOM, py / GRID), aBg);
      }

      // 2. The document.
      const dDoc = sdRoundedRect(px, py, 512, 500, 200, 250, 36);
      const aDoc = coverage(dDoc, unit) * aBg;
      if (aDoc > 0) over(buf, i, PAPER, aDoc);

      // 3. Three rules. The third is short, which is what makes it read as a
      //    page of text rather than a barcode.
      let aRule = 0;
      aRule = Math.max(aRule, coverage(sdSegment(px, py, 389, 350, 635, 350, 17), unit));
      aRule = Math.max(aRule, coverage(sdSegment(px, py, 389, 430, 635, 430, 17), unit));
      aRule = Math.max(aRule, coverage(sdSegment(px, py, 389, 510, 552, 510, 17), unit));
      if (aRule > 0) over(buf, i, RULE, aRule * aDoc);

      // 4. The check: reviewed and approved, which is the whole product.
      let aMark = 0;
      aMark = Math.max(aMark, coverage(sdSegment(px, py, 404, 626, 474, 692, 21), unit));
      aMark = Math.max(aMark, coverage(sdSegment(px, py, 474, 692, 626, 566, 21), unit));
      if (aMark > 0) over(buf, i, MARK, aMark * aDoc);
    }
  }
  return buf;
}

// --- PNG -------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10..12 stay zero: deflate, adaptive filtering, no interlace.

  // Filter type 0 per scanline. These are tiny images and zlib handles the
  // flat colour fine; a filter search would buy nothing.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    const at = y * (size * 4 + 1);
    raw[at] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * size * 4, size * 4).copy(raw, at + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- iconset ---------------------------------------------------------------

// Exactly the names iconutil expects. Anything else is silently ignored, which
// is how an .icns ends up missing its Dock size.
const VARIANTS = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];

export function writeIconset(dir) {
  mkdirSync(dir, { recursive: true });
  const cache = new Map();
  for (const [name, size] of VARIANTS) {
    let png = cache.get(size);
    if (png === undefined) {
      png = encodePng(size, render(size));
      cache.set(size, png);
    }
    writeFileSync(join(dir, name), png);
  }
  return VARIANTS.map(([name]) => name);
}

function main() {
  const out = process.argv[2];
  if (!out) {
    process.stderr.write('usage: node scripts/make-icon.mjs <output.icns>\n');
    process.exit(2);
  }
  const work = mkdtempSync(join(tmpdir(), 'ibc-icon-'));
  try {
    const iconset = join(work, 'IBCContracts.iconset');
    writeIconset(iconset);
    mkdirSync(dirname(out), { recursive: true });
    const r = spawnSync('iconutil', ['-c', 'icns', '-o', out, iconset], { stdio: 'inherit' });
    if (r.status !== 0) {
      process.stderr.write('iconutil could not build the icon.\n');
      process.exit(1);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// Importable for tests, runnable for the installer.
if (process.argv[1] && process.argv[1].endsWith('make-icon.mjs')) main();
