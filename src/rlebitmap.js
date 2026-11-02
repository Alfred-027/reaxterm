'use strict';
// Bitmaps RDP comprimidos con Â«interleaved RLEÂ» (MS-RDPBCGR 2.2.9.1.1.3.1.2.4), para 8/15/16/24 bpp.
// Se usan para corregir en el puente los bitmaps cuyo ancho trae relleno (ancho > rectÃ¡ngulo destino),
// que IronRDP 0.7 dibuja inclinados y que, en el borde derecho de la pantalla, lo hacen fallar.
// El bitmap se descomprime, se recorta al rectÃ¡ngulo y se entrega sin comprimir a 32 bpp.

const REGULAR_BG_RUN = 0x0, MEGA_MEGA_BG_RUN = 0xf0;
const REGULAR_FG_RUN = 0x1, MEGA_MEGA_FG_RUN = 0xf1;
const LITE_SET_FG_FG_RUN = 0xc, MEGA_MEGA_SET_FG_RUN = 0xf6;
const LITE_DITHERED_RUN = 0xe, MEGA_MEGA_DITHERED_RUN = 0xf8;
const REGULAR_COLOR_RUN = 0x3, MEGA_MEGA_COLOR_RUN = 0xf3;
const REGULAR_FGBG_IMAGE = 0x2, MEGA_MEGA_FGBG_IMAGE = 0xf2;
const LITE_SET_FG_FGBG_IMAGE = 0xd, MEGA_MEGA_SET_FGBG_IMAGE = 0xf7;
const REGULAR_COLOR_IMAGE = 0x4, MEGA_MEGA_COLOR_IMAGE = 0xf4;
const SPECIAL_FGBG_1 = 0xf9, SPECIAL_FGBG_2 = 0xfa, SPECIAL_WHITE = 0xfd, SPECIAL_BLACK = 0xfe;

function codeId(h) {
  if ((h & 0xc0) !== 0xc0) return h >> 5;
  if ((h & 0xf0) === 0xf0) return h;
  return h >> 4;
}

// Devuelve los pÃ­xeles (un nÃºmero por pÃ­xel) en el orden del flujo: la primera fila es la de abajo
function decompress(src, width, height, bpp) {
  const bytes = bpp === 8 ? 1 : bpp === 24 ? 3 : 2;
  const white = bpp === 8 ? 0xff : bpp === 15 ? 0x7fff : bpp === 16 ? 0xffff : 0xffffff;
  const total = width * height;
  const out = new Uint32Array(total);
  let d = 0;
  let s = 0;
  let fg = white;
  let insertFg = false;

  const need = (n) => { if (s + n > src.length) throw new Error('RLE: datos insuficientes'); };
  const pixel = () => {
    need(bytes);
    const v = bytes === 1 ? src[s] : bytes === 2 ? src.readUInt16LE(s) : src[s] | (src[s + 1] << 8) | (src[s + 2] << 16);
    s += bytes;
    return v;
  };
  const put = (v) => { if (d >= total) throw new Error('RLE: desborde'); out[d++] = v; };
  const above = () => out[d - width];

  function runLength(code) {
    const h = src[s];
    let n;
    switch (code) {
      case REGULAR_FGBG_IMAGE:
        n = h & 0x1f; s += 1;
        if (n === 0) { need(1); n = src[s++] + 1; } else n *= 8;
        return n;
      case LITE_SET_FG_FGBG_IMAGE:
        n = h & 0x0f; s += 1;
        if (n === 0) { need(1); n = src[s++] + 1; } else n *= 8;
        return n;
      case REGULAR_BG_RUN: case REGULAR_FG_RUN: case REGULAR_COLOR_RUN: case REGULAR_COLOR_IMAGE:
        n = h & 0x1f; s += 1;
        if (n === 0) { need(1); n = src[s++] + 32; }
        return n;
      case LITE_SET_FG_FG_RUN: case LITE_DITHERED_RUN:
        n = h & 0x0f; s += 1;
        if (n === 0) { need(1); n = src[s++] + 16; }
        return n;
      default: // MEGA_MEGA_*
        s += 1; need(2);
        n = src.readUInt16LE(s); s += 2;
        return n;
    }
  }

  function fgbg(mask, bits, firstLine) {
    for (let i = 0; i < bits; i++) {
      const set = (mask >> i) & 1;
      if (firstLine) put(set ? fg : 0);
      else { const a = above(); put(set ? a ^ fg : a); }
    }
  }

  while (s < src.length && d < total) {
    // como en la especificación: «primera fila» se evalúa una vez por orden
    const firstLine = d < width;
    const code = codeId(src[s]);

    if (code === REGULAR_BG_RUN || code === MEGA_MEGA_BG_RUN) {
      let n = runLength(code);
      if (insertFg && n > 0) { put(firstLine ? fg : above() ^ fg); n--; }
      for (; n > 0; n--) put(firstLine ? 0 : above());
      insertFg = true;
      continue;
    }
    insertFg = false;

    switch (code) {
      case REGULAR_FG_RUN: case MEGA_MEGA_FG_RUN: case LITE_SET_FG_FG_RUN: case MEGA_MEGA_SET_FG_RUN: {
        const n = runLength(code);
        if (code === LITE_SET_FG_FG_RUN || code === MEGA_MEGA_SET_FG_RUN) fg = pixel();
        for (let i = 0; i < n; i++) put(firstLine ? fg : above() ^ fg);
        break;
      }
      case LITE_DITHERED_RUN: case MEGA_MEGA_DITHERED_RUN: {
        const n = runLength(code);
        const a = pixel(), b = pixel();
        for (let i = 0; i < n; i++) { put(a); put(b); }
        break;
      }
      case REGULAR_COLOR_RUN: case MEGA_MEGA_COLOR_RUN: {
        const n = runLength(code);
        const p = pixel();
        for (let i = 0; i < n; i++) put(p);
        break;
      }
      case REGULAR_FGBG_IMAGE: case MEGA_MEGA_FGBG_IMAGE: case LITE_SET_FG_FGBG_IMAGE: case MEGA_MEGA_SET_FGBG_IMAGE: {
        let n = runLength(code);
        if (code === LITE_SET_FG_FGBG_IMAGE || code === MEGA_MEGA_SET_FGBG_IMAGE) fg = pixel();
        while (n > 0) {
          need(1);
          const mask = src[s++];
          const bits = Math.min(8, n);
          fgbg(mask, bits, firstLine);
          n -= bits;
        }
        break;
      }
      case REGULAR_COLOR_IMAGE: case MEGA_MEGA_COLOR_IMAGE: {
        const n = runLength(code);
        for (let i = 0; i < n; i++) put(pixel());
        break;
      }
      case SPECIAL_FGBG_1: s += 1; fgbg(0x03, 8, firstLine); break;
      case SPECIAL_FGBG_2: s += 1; fgbg(0x05, 8, firstLine); break;
      case SPECIAL_WHITE: s += 1; put(white); break;
      case SPECIAL_BLACK: s += 1; put(0); break;
      default: throw new Error('RLE: orden desconocida ' + code);
    }
  }
  if (d !== total) throw new Error(`RLE: ${d} de ${total} pÃ­xeles`);
  return out;
}

// PÃ­xel de 15/16/24 bpp a BGRX de 32 bits
function toBgrx(v, bpp, buf, o) {
  let r, g, b;
  if (bpp === 16) { r = (v >> 11) & 0x1f; g = (v >> 5) & 0x3f; b = v & 0x1f; r = (r << 3) | (r >> 2); g = (g << 2) | (g >> 4); b = (b << 3) | (b >> 2); }
  else if (bpp === 15) { r = (v >> 10) & 0x1f; g = (v >> 5) & 0x1f; b = v & 0x1f; r = (r << 3) | (r >> 2); g = (g << 3) | (g >> 2); b = (b << 3) | (b >> 2); }
  else { b = v & 0xff; g = (v >> 8) & 0xff; r = (v >> 16) & 0xff; }
  buf[o] = b; buf[o + 1] = g; buf[o + 2] = r; buf[o + 3] = 0xff;
}

// Recorta un bitmap descomprimido al rectÃ¡ngulo destino y lo divide en franjas que caben en un PDU.
// Devuelve [{ top, bottom, data }] con data en BGRX 32 bpp, filas de abajo hacia arriba (como TS_BITMAP_DATA).
function cropToBands(pixels, width, height, bpp, destW, destH, maxBytes) {
  const rowBytes = destW * 4;
  const rowsPerBand = Math.max(1, Math.floor(maxBytes / rowBytes));
  const bands = [];
  for (let top = 0; top < destH; top += rowsPerBand) {
    const bottom = Math.min(destH, top + rowsPerBand) - 1; // filas destino top..bottom (de arriba hacia abajo)
    const n = bottom - top + 1;
    const data = Buffer.alloc(n * rowBytes);
    for (let k = 0; k < n; k++) {
      const destRow = bottom - k;          // abajo hacia arriba
      const srcRow = height - 1 - destRow; // fila en el flujo RLE (la primera es la de abajo)
      for (let x = 0; x < destW; x++) toBgrx(pixels[srcRow * width + x], bpp, data, k * rowBytes + x * 4);
    }
    bands.push({ top, bottom, data });
  }
  return bands;
}

module.exports = { decompress, cropToBands };
