// One-off generator for `references/silhouette.png` — the bundled placeholder
// the registry falls back to when the acceptance gate fails twice (design
// law §3, finding 36: "no wrong face ever ships"). Not a runtime dependency:
// this script runs once, at authoring time, to produce a checked-in asset.
// No image library — a hand-rolled minimal PNG encoder using only Node's
// built-in zlib for the DEFLATE stream, per the module contract's
// "no runtime dependencies beyond Node built-ins" rule.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const WIDTH = 832;
const HEIGHT = 1216;
// A dark neutral card — a silhouette placeholder, not a rendered portrait.
const R = 0x1a, G = 0x18, B = 0x22;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Standard CRC-32 (IEEE 802.3) — the same polynomial the PNG spec requires
// for every chunk's trailing CRC.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function buildIhdr(width, height) {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = 8; // bit depth
  data[9] = 2; // color type 2 = truecolor (RGB)
  data[10] = 0; // compression method
  data[11] = 0; // filter method
  data[12] = 0; // interlace method
  return data;
}

function buildRawScanlines(width, height, r, g, b) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter type 0 = none
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 3;
      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
    }
  }
  return raw;
}

const ihdr = chunk('IHDR', buildIhdr(WIDTH, HEIGHT));
const raw = buildRawScanlines(WIDTH, HEIGHT, R, G, B);
const idat = chunk('IDAT', deflateSync(raw));
const iend = chunk('IEND', Buffer.alloc(0));

const png = Buffer.concat([PNG_SIGNATURE, ihdr, idat, iend]);

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = join(__dirname, '..', 'references', 'silhouette.png');
writeFileSync(outPath, png);
console.log(`wrote ${outPath} (${png.length} bytes, ${WIDTH}x${HEIGHT})`);
