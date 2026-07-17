/**
 * 生成简易 PNG 图标（无外部依赖）
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, "..", "public", "icons");
mkdirSync(outDir, { recursive: true });

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function makePng(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const r = Math.max(4, Math.floor(size * 0.18));

  const setPx = (x, y, color) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    rgba[i] = color[0];
    rgba[i + 1] = color[1];
    rgba[i + 2] = color[2];
    rgba[i + 3] = color[3];
  };

  const inRoundRect = (x, y) => {
    const xi = Math.max(x, r) - Math.min(x, size - 1 - r);
    const yi = Math.max(y, r) - Math.min(y, size - 1 - r);
    if (x >= r && x < size - r && y >= 0 && y < size) return true;
    if (y >= r && y < size - r && x >= 0 && x < size) return true;
    return xi * xi + yi * yi <= r * r;
  };

  const bg = [225, 29, 72, 255];
  const ink = [255, 255, 255, 255];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (inRoundRect(x, y)) setPx(x, y, bg);
      else setPx(x, y, [0, 0, 0, 0]);
    }
  }

  const drawRect = (x0, y0, w, h, color) => {
    const X0 = Math.floor(x0 * size);
    const Y0 = Math.floor(y0 * size);
    const X1 = Math.ceil((x0 + w) * size);
    const Y1 = Math.ceil((y0 + h) * size);
    for (let y = Y0; y < Y1; y++) {
      for (let x = X0; x < X1; x++) setPx(x, y, color);
    }
  };

  drawRect(0.22, 0.28, 0.08, 0.44, ink);
  drawRect(0.22, 0.28, 0.22, 0.08, ink);
  drawRect(0.22, 0.46, 0.2, 0.08, ink);
  drawRect(0.36, 0.36, 0.08, 0.1, ink);
  drawRect(0.34, 0.54, 0.1, 0.18, ink);
  drawRect(0.52, 0.28, 0.08, 0.44, ink);
  drawRect(0.52, 0.28, 0.24, 0.08, ink);
  drawRect(0.52, 0.46, 0.18, 0.08, ink);

  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of [16, 48, 128]) {
  writeFileSync(join(outDir, `icon${size}.png`), makePng(size));
  console.log(`wrote icon${size}.png`);
}
