// 依存なしの最小PNGエンコーダで拡張アイコン（16/48/128px）を生成する。
// 使用モジュールは node:zlib（deflateSync / crc32）と node:fs のみ。
import { deflateSync, crc32 } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @param {string} type @param {Buffer} data */
function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput) >>> 0, 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/** @param {number} width @param {number} height @param {Buffer} rgba */
function encodePng(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type: RGBA
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  const ihdr = chunk("IHDR", ihdrData);

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // フィルタなし
    rgba.copy(raw, rowStart + 1, y * stride, y * stride + stride);
  }
  const idat = chunk("IDAT", deflateSync(raw, { level: 9 }));
  const iend = chunk("IEND", Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

function dist(x1, y1, x2, y2) {
  return Math.hypot(x1 - x2, y1 - y2);
}

function isInRoundedRect(px, py, x, y, w, h, r) {
  if (px < x || px > x + w || py < y || py > y + h) return false;
  if (px < x + r && py < y + r) return dist(px, py, x + r, y + r) <= r;
  if (px > x + w - r && py < y + r) return dist(px, py, x + w - r, y + r) <= r;
  if (px < x + r && py > y + h - r) return dist(px, py, x + r, y + h - r) <= r;
  if (px > x + w - r && py > y + h - r) return dist(px, py, x + w - r, y + h - r) <= r;
  return true;
}

/** 青い円の背景 + 白い書類 + 見出し行っぽい3本線、という「ブログ記事」アイコン */
function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const bg = [37, 99, 235, 255]; // 青
  const fg = [255, 255, 255, 255]; // 白
  const accent = [147, 197, 253, 255]; // 薄い青（見出し線）

  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.5;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const inCircle = dx * dx + dy * dy <= r * r;
      if (inCircle) {
        rgba[idx] = bg[0];
        rgba[idx + 1] = bg[1];
        rgba[idx + 2] = bg[2];
        rgba[idx + 3] = bg[3];
      } else {
        rgba[idx + 3] = 0; // 透明
      }
    }
  }

  const docW = size * 0.52;
  const docH = size * 0.64;
  const docX = (size - docW) / 2;
  const docY = (size - docH) / 2;
  const radius = Math.max(1, size * 0.08);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (isInRoundedRect(x + 0.5, y + 0.5, docX, docY, docW, docH, radius)) {
        const idx = (y * size + x) * 4;
        rgba[idx] = fg[0];
        rgba[idx + 1] = fg[1];
        rgba[idx + 2] = fg[2];
        rgba[idx + 3] = 255;
      }
    }
  }

  const lineHeight = Math.max(1, Math.round(size * 0.07));
  const lineMarginX = docX + docW * 0.18;
  const lineWidths = [docW * 0.64, docW * 0.64, docW * 0.4];
  for (let i = 0; i < lineWidths.length; i++) {
    const lineY = Math.round(docY + docH * (0.24 + i * 0.24));
    for (let y = lineY; y < lineY + lineHeight; y++) {
      for (let x = Math.round(lineMarginX); x < Math.round(lineMarginX + lineWidths[i]); x++) {
        if (x < 0 || x >= size || y < 0 || y >= size) continue;
        const idx = (y * size + x) * 4;
        rgba[idx] = accent[0];
        rgba[idx + 1] = accent[1];
        rgba[idx + 2] = accent[2];
        rgba[idx + 3] = 255;
      }
    }
  }

  return rgba;
}

const sizes = [16, 48, 128];
const outDir = path.resolve(__dirname, "..", "public", "icons");
mkdirSync(outDir, { recursive: true });

for (const size of sizes) {
  const rgba = drawIcon(size);
  const png = encodePng(size, size, rgba);
  const outPath = path.join(outDir, `${size}.png`);
  writeFileSync(outPath, png);
  console.log(`generated public/icons/${size}.png (${png.length} bytes)`);
}
