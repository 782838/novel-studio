'use strict';
/**
 * 纯 Node 生成应用图标 build/icon.ico（无需任何图形库）。
 * 图案：靛蓝渐变圆角方块 + 白色摊开的书本。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---------------- PNG 编码 ---------------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function encodePNG(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit, RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------------- 绘制 ---------------- */
function inRoundRect(x, y, W, H, R) {
  const cx = Math.min(Math.max(x, R), W - R);
  const cy = Math.min(Math.max(y, R), H - R);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= R * R;
}
function inPoly(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
const lerp = (a, b, t) => a + (b - a) * t;

// 归一化(0..1)坐标下的书本多边形
const PAGE_L = [[0.50, 0.505], [0.148, 0.625], [0.148, 0.835], [0.50, 0.745]];
const PAGE_R = [[0.50, 0.505], [0.852, 0.625], [0.852, 0.835], [0.50, 0.745]];

function renderAt(size, S) {
  const N = size * S;
  const buf = Buffer.alloc(N * N * 4);
  const R = N * 0.225;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      const px = (x + 0.5) / N, py = (y + 0.5) / N;
      if (!inRoundRect(x + 0.5, y + 0.5, N, N, R)) continue; // 透明
      const t = py;
      let r = Math.round(lerp(79, 124, t));
      let g = Math.round(lerp(70, 108, t));
      let b = Math.round(lerp(229, 245, t));
      const inBook = inPoly(px, py, PAGE_L) || inPoly(px, py, PAGE_R);
      if (inBook) {
        if (px > 0.487 && px < 0.513) { r = 226; g = 226; b = 242; } // 书脊阴影
        else { r = 255; g = 255; b = 255; }
      }
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
    }
  }
  // 盒式降采样
  if (S === 1) return buf;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const j = ((y * S + sy) * N + (x * S + sx)) * 4;
          r += buf[j]; g += buf[j + 1]; b += buf[j + 2]; a += buf[j + 3];
        }
      }
      const k = S * S, o = (y * size + x) * 4;
      out[o] = Math.round(r / k); out[o + 1] = Math.round(g / k);
      out[o + 2] = Math.round(b / k); out[o + 3] = Math.round(a / k);
    }
  }
  return out;
}

/* ---------------- ICO 封装 ---------------- */
function buildIco(sizes) {
  const images = sizes.map((s) => ({ size: s, png: encodePNG(s, s, renderAt(s, s <= 64 ? 4 : 2)) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const entries = images.map((im) => {
    const e = Buffer.alloc(16);
    e[0] = im.size >= 256 ? 0 : im.size;
    e[1] = im.size >= 256 ? 0 : im.size;
    e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4);   // planes
    e.writeUInt16LE(32, 6);  // bpp
    e.writeUInt32LE(im.png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += im.png.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

const outDir = path.join(__dirname);
const sizes = [16, 24, 32, 48, 64, 128, 256];
const ico = buildIco(sizes);
fs.writeFileSync(path.join(outDir, 'icon.ico'), ico);
fs.writeFileSync(path.join(outDir, 'icon.png'), encodePNG(256, 256, renderAt(256, 2)));
console.log('icon.ico 已生成：', ico.length, 'bytes, sizes =', sizes.join('/'));
