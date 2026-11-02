'use strict';
// Puente RDCleanPath para el cliente RDP en WebAssembly (IronRDP).
// El navegador no puede abrir TCP ni hacer TLS por su cuenta: el cliente envía por WebSocket una
// petición RDCleanPath (DER) con el X.224 Connection Request; aquí se conecta al servidor, se hace
// el TLS, se devuelve la respuesta X.224 con la cadena de certificados y desde ahí se reenvía todo.
// El servidor WebSocket sólo escucha en 127.0.0.1 y cada conexión exige un token de un solo uso.
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const VERSION_1 = 3390;
// La verificación del servidor la hace el usuario con la huella del certificado (como en SSH)
const TLS_MODERN = { minVersion: 'TLSv1' };
const TLS_RSA = { minVersion: 'TLSv1', maxVersion: 'TLSv1.2', ciphers: 'AES128-GCM-SHA256:AES256-GCM-SHA384:AES128-SHA256:AES256-SHA256:AES128-SHA:AES256-SHA' };

// ---------------------------------------------------------------- DER mínimo
function derLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  while (n > 0) { bytes.unshift(n & 0xff); n >>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, content) => Buffer.concat([Buffer.from([tag]), derLen(content.length), content]);
function derInt(n) {
  const bytes = [];
  do { bytes.unshift(n & 0xff); n = Math.floor(n / 256); } while (n > 0);
  if (bytes[0] & 0x80) bytes.unshift(0);
  return tlv(0x02, Buffer.from(bytes));
}
const ctx = (n, inner) => tlv(0xa0 | n, inner); // etiqueta explícita [n]

function readTlv(buf, off) {
  if (off + 2 > buf.length) return null;
  const tag = buf[off];
  let len = buf[off + 1];
  let p = off + 2;
  if (len & 0x80) {
    const nb = len & 0x7f;
    if (p + nb > buf.length) return null;
    len = 0;
    for (let i = 0; i < nb; i++) len = len * 256 + buf[p + i];
    p += nb;
  }
  if (p + len > buf.length) return null;
  return { tag, start: p, end: p + len, next: p + len };
}

function decodeRequest(buf) {
  const seq = readTlv(buf, 0);
  if (!seq || seq.tag !== 0x30) return null;
  const out = { total: seq.next };
  for (let p = seq.start; p < seq.end;) {
    const field = readTlv(buf, p);
    const inner = readTlv(buf, field.start);
    const v = buf.subarray(inner.start, inner.end);
    switch (field.tag & 0x1f) {
      case 0: out.version = v.reduce((a, b) => a * 256 + b, 0); break;
      case 2: out.destination = v.toString('utf8'); break;
      case 3: out.proxyAuth = v.toString('utf8'); break;
      case 5: out.pcb = v.toString('utf8'); break;
      case 6: out.x224 = Buffer.from(v); break;
      default: break;
    }
    p = field.next;
  }
  return out;
}

function encodeResponse(serverAddr, x224, chain) {
  return tlv(0x30, Buffer.concat([
    ctx(0, derInt(VERSION_1)),
    ctx(6, tlv(0x04, x224)),
    ctx(7, tlv(0x30, Buffer.concat(chain.map((c) => tlv(0x04, c))))),
    ctx(9, tlv(0x0c, Buffer.from(serverAddr, 'utf8'))),
  ]));
}

function encodeError({ code = 1, wsa, tlsAlert, x224 } = {}) {
  const err = [ctx(0, derInt(code))];
  if (wsa != null) err.push(ctx(2, derInt(wsa)));
  if (tlsAlert != null) err.push(ctx(3, derInt(tlsAlert)));
  const parts = [ctx(0, derInt(VERSION_1)), ctx(1, tlv(0x30, Buffer.concat(err)))];
  if (x224) parts.push(ctx(6, tlv(0x04, x224)));
  return tlv(0x30, Buffer.concat(parts));
}

const WSA = { ECONNREFUSED: 10061, ETIMEDOUT: 10060, EHOSTUNREACH: 10065, ENETUNREACH: 10051, ECONNRESET: 10054, ENOTFOUND: 11001, EAI_AGAIN: 11002 };

// ---------------------------------------------------------------- X.224 sobre TCP
function readTpkt(sock, timeout = 15000) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => done(new Error('El servidor RDP no respondió a la negociación')), timeout);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= 4) {
        const len = buf.readUInt16BE(2);
        if (buf.length >= len) done(null, buf.subarray(0, len), buf.subarray(len));
      }
    };
    const onErr = (e) => done(e);
    const onClose = () => done(new Error('El servidor cerró la conexión durante la negociación'));
    function done(err, pdu, rest) {
      clearTimeout(timer);
      sock.off('data', onData); sock.off('error', onErr); sock.off('close', onClose);
      if (err) reject(err); else { if (rest && rest.length) sock.unshift(rest); resolve(pdu); }
    }
    sock.on('data', onData); sock.once('error', onErr); sock.once('close', onClose);
  });
}

function certChain(tlsSock) {
  const chain = [];
  const seen = new Set();
  let c = tlsSock.getPeerCertificate(true);
  while (c && c.raw && !seen.has(c.fingerprint256)) {
    seen.add(c.fingerprint256);
    chain.push(c.raw);
    c = c.issuerCertificate;
  }
  return chain;
}

// ---------------------------------------------------------------- compatibilidad con servidores antiguos
// Algunos Windows antiguos envían varios PDU «Share Control» (p. ej. Synchronize + Control + Font Map)
// dentro de un mismo MCS Send Data Indication. IronRDP espera uno por paquete y falla al decodificar.
// Aquí se separan en paquetes independientes, sólo si el contenido calza exactamente con ese patrón.
// Antes del MCS Connect Response (fase CredSSP) el tráfico pasa intacto; ante cualquier duda, también.
// notify(kind) avisa una vez de lo que el servidor soporta: 'displayControl' (cambio de resolución en
// caliente) u 'orders' (dibuja con órdenes GDI, que IronRDP no implementa).
const DISPLAY_CONTROL = Buffer.from('Microsoft::Windows::RDS::DisplayControl');
const { decompress, cropToBands } = require('./rlebitmap');
function createPduSplitter(log, notify = () => {}) {
  const notified = new Set();
  const once = (kind) => { if (!notified.has(kind)) { notified.add(kind); notify(kind); } };
  let framed = false;   // ya empezó el tráfico TPKT / fast-path
  let broken = false;   // algo no calzó: se deja de tocar el tráfico
  let buf = Buffer.alloc(0);
  let frames = 0;
  let splitLogs = 0;

  const perLen = (n) => (n < 0x80 ? Buffer.from([n]) : Buffer.from([0x80 | (n >> 8), n & 0xff]));

  // Diagnóstico: cuenta los tipos de PDU recibidos (sólo códigos de estructura) y los resume cada 3 s
  const kinds = new Map();
  let flushTimer = null;
  function count(key) {
    kinds.set(key, (kinds.get(key) || 0) + 1);
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        log(`rdp: recibido ${[...kinds].map(([k, n]) => `${k}×${n}`).join(', ')}`);
        kinds.clear();
      }, 3000);
    }
  }
  function describeFast(frame) {
    let p = frame[1] & 0x80 ? 3 : 2;
    if (frame[0] & 0x80) p += 8; // firma FIPS/RDP
    const h = frame[p];
    if (h === undefined) return count('fast:vacío');
    const comp = (h >> 6) & 3;
    count(`fast:upd${h & 0x0f}${(h >> 4) & 3 ? '/frag' + ((h >> 4) & 3) : ''}${comp & 2 ? '/comp' + (frame[p + 1] & 0xff).toString(16) : ''}`);
  }
  // Demand Active: tamaño de escritorio y profundidad de color que anuncia el servidor (capacidad Bitmap)
  function describeDemand(pdu) {
    if (pdu.length < 14) return;
    let p = 6 + 4;
    const lenSource = pdu.readUInt16LE(p);
    p += 4 + lenSource + 4;
    while (p + 4 <= pdu.length) {
      const capType = pdu.readUInt16LE(p), capLen = pdu.readUInt16LE(p + 2);
      if (capLen < 4) break;
      if (capType === 2 && p + 16 <= pdu.length) {
        return log(`rdp: el servidor activa ${pdu.readUInt16LE(p + 12)}x${pdu.readUInt16LE(p + 14)} a ${pdu.readUInt16LE(p + 4)} bpp`);
      }
      p += capLen;
    }
  }
  // Actualización de bitmaps (slow-path): profundidad, compresión y si el ancho calza con el rectángulo
  function describeBitmaps(pdu) {
    let p = 18 + 2;
    const n = pdu.readUInt16LE(p); p += 2;
    for (let i = 0; i < n && p + 18 <= pdu.length; i++) {
      const l = pdu.readUInt16LE(p), r = pdu.readUInt16LE(p + 4), w = pdu.readUInt16LE(p + 8);
      const bpp = pdu.readUInt16LE(p + 12), flags = pdu.readUInt16LE(p + 14), len = pdu.readUInt16LE(p + 16);
      count(`bmp${bpp}${flags & 1 ? 'c' : 'u'}${flags & 0x400 ? 'n' : ''}${w !== r - l + 1 ? '/ancho' + (w - (r - l + 1)) : ''}`);
      p += 18 + len; // bitmapLength incluye la cabecera de compresión opcional
    }
  }

  // IronRDP 0.7 dibuja mal los bitmaps comprimidos cuyo ancho trae relleno (ancho > rectángulo): salen
  // inclinados y, en el borde derecho de la pantalla, el decodificador falla y todo queda en negro.
  // Esos bitmaps se descomprimen aquí, se recortan al rectángulo y se envían sin comprimir a 32 bpp.
  const MAX_BAND = 15800; // datos por PDU: la longitud PER de MCS admite hasta 16383 bytes
  function fixBitmapUpdate(pdu) {
    if (pdu.length < 22 || (pdu.readUInt16LE(2) & 0x0f) !== 7 || pdu[14] !== 2 || (pdu[15] & 0x20) || pdu.readUInt16LE(18) !== 1) return null;
    const rects = [];
    let p = 22;
    for (let i = pdu.readUInt16LE(20); i > 0; i--) {
      if (p + 18 > pdu.length) return null;
      const r = { l: pdu.readUInt16LE(p), t: pdu.readUInt16LE(p + 2), r: pdu.readUInt16LE(p + 4), b: pdu.readUInt16LE(p + 6),
        w: pdu.readUInt16LE(p + 8), h: pdu.readUInt16LE(p + 10), bpp: pdu.readUInt16LE(p + 12), flags: pdu.readUInt16LE(p + 14) };
      const len = pdu.readUInt16LE(p + 16);
      if (p + 18 + len > pdu.length) return null;
      r.raw = pdu.subarray(p, p + 18 + len);
      r.data = pdu.subarray(p + 18 + (r.flags & 0x400 ? 0 : 8), p + 18 + len);
      r.dw = r.r - r.l + 1; r.dh = r.b - r.t + 1;
      r.bad = (r.flags & 1) && [15, 16, 24].includes(r.bpp) && r.dw > 0 && r.dh > 0 && r.dw <= r.w && r.dh <= r.h && (r.dw !== r.w || r.dh !== r.h);
      rects.push(r);
      p += 18 + len;
    }
    if (!rects.some((r) => r.bad)) return null;
    const head = pdu.subarray(0, 18);
    const diff = pdu.readUInt16LE(0) - pdu.readUInt16LE(12);
    const make = (bufs) => {
      const body = Buffer.concat([Buffer.from([1, 0, bufs.length & 0xff, bufs.length >> 8]), ...bufs]);
      const share = Buffer.concat([head, body]);
      share.writeUInt16LE(share.length, 0);
      share.writeUInt16LE(Math.max(0, share.length - diff), 12);
      return share;
    };
    const out = [];
    let pending = [];
    const flush = () => { if (pending.length) { out.push(make(pending)); pending = []; } };
    for (const r of rects) {
      if (!r.bad) { pending.push(r.raw); continue; }
      let bands;
      try {
        bands = cropToBands(decompress(r.data, r.w, r.h, r.bpp), r.w, r.h, r.bpp, r.dw, r.dh, MAX_BAND);
      } catch (e) {
        count('bmp-sin-corregir');
        if (rleErrors++ < 5) log('rdp: ' + e.message);
        pending.push(r.raw);
        continue;
      }
      flush();
      for (const band of bands) {
        const hd = Buffer.alloc(18);
        hd.writeUInt16LE(r.l, 0); hd.writeUInt16LE(r.t + band.top, 2); hd.writeUInt16LE(r.r, 4); hd.writeUInt16LE(r.t + band.bottom, 6);
        hd.writeUInt16LE(r.dw, 8); hd.writeUInt16LE(band.bottom - band.top + 1, 10); hd.writeUInt16LE(32, 12); hd.writeUInt16LE(0, 14);
        hd.writeUInt16LE(band.data.length, 16);
        out.push(make([Buffer.concat([hd, band.data])]));
      }
      count('bmp-corregido');
    }
    flush();
    return out;
  }
  let rleErrors = 0;

  function describeShare(pdu) {
    const type = pdu.readUInt16LE(2) & 0x0f;
    if (type === 1) describeDemand(pdu);
    if (type !== 7 || pdu.length < 18) return count(`ctl${type}`);
    const pduType2 = pdu[14], compressed = pdu[15];
    let k = `data${pduType2}`;
    if (compressed & 0x20) k += '/comp' + compressed.toString(16);
    else if (pduType2 === 2 && pdu.length >= 20) {
      k += '/upd' + pdu.readUInt16LE(18);
      if (pdu.readUInt16LE(18) === 1 && pdu.length >= 22) describeBitmaps(pdu);
      // órdenes de dibujo (MS-RDPEGDI): se anota el tipo de la primera orden
      if (pdu.readUInt16LE(18) === 0) once('orders');
      if (pdu.readUInt16LE(18) === 0 && pdu.length >= 28) {
        const flags = pdu[26];
        if (flags & 0x02) k += '/sec' + (pdu.length > 31 ? pdu[31] : '?');
        else if (flags & 0x01) k += '/prim' + (flags & 0x08 ? pdu[27] : '=');
      }
    }
    else if (pduType2 === 27 && pdu.length >= 20) k += '/ptr' + pdu.readUInt16LE(18);
    if (pduType2 === 40) notify('fontMap'); // fin de la (re)activación
    count(k);
  }

  function splitSlowPath(frame) {
    // TPKT(4) + X.224 Data(3: 02 f0 80) + MCS SDin (0x68)
    if (frame.length < 15 || frame[4] !== 0x02 || frame[5] !== 0xf0 || frame[6] !== 0x80 || (frame[7] >> 2) !== 26) return [frame];
    const mcsHead = frame.subarray(7, 13); // tipo, iniciador(2), canal(2), prioridad/segmentación
    let off = 13;
    let len = frame[off];
    if (len & 0x80) { len = ((len & 0x3f) << 8) | frame[off + 1]; off += 2; } else off += 1;
    const data = frame.subarray(off);
    const other = () => {
      count(`canal${frame.readUInt16BE(10)}`);
      if (frame.includes(DISPLAY_CONTROL)) once('displayControl');
      return [frame];
    };
    if (data.length !== len || len < 12) return other();
    const parts = [];
    for (let p = 0; p < data.length;) {
      if (p + 6 > data.length) return other();
      const total = data.readUInt16LE(p);
      const type = data.readUInt16LE(p + 2);
      if (total < 6 || (type & 0xfff0) !== 0x0010 || p + total > data.length) return other();
      parts.push(data.subarray(p, p + total));
      p += total;
    }
    parts.forEach(describeShare);
    // bitmaps con ancho de relleno: se reemplazan por la versión recortada (ver src/rlebitmap.js)
    let fixed = false;
    for (let i = parts.length - 1; i >= 0; i--) {
      const rep = fixBitmapUpdate(parts[i]);
      if (rep) { parts.splice(i, 1, ...rep); fixed = true; }
    }
    if (parts.length < 2 && !fixed) return [frame];
    if (parts.length > 1 && splitLogs++ < 40) log(`rdp: paquete con ${parts.length} PDU (${parts.map((x) => x.length).join('+')} bytes) separado`);
    return parts.map((part) => {
      const body = Buffer.concat([Buffer.from([0x02, 0xf0, 0x80]), mcsHead, perLen(part.length), part]);
      const tpkt = Buffer.from([0x03, 0x00, 0, 0]);
      tpkt.writeUInt16BE(4 + body.length, 2);
      return Buffer.concat([tpkt, body]);
    });
  }

  // Durante una (re)activación (desde Demand Active hasta Font Map) IronRDP descarta los gráficos, pero los
  // Windows antiguos repintan la pantalla justo entonces y queda en negro. Esos gráficos se retienen y se
  // entregan inmediatamente después del Font Map, en el mismo orden.
  let holding = false;
  let held = [];
  function stage(frame) {
    const share = shareOf(frame);
    if (share && (share.readUInt16LE(2) & 0x0f) === 1) { holding = true; return [frame]; } // Demand Active
    if (share && (share.readUInt16LE(2) & 0x0f) === 7 && share.length >= 18 && !(share[15] & 0x20)) {
      const pduType2 = share[14];
      if (pduType2 === 40 && holding) { // Font Map: fin de la activación
        const out = [frame, ...held];
        if (held.length) log(`rdp: ${held.length} actualizaciones gráficas recibidas durante la activación, entregadas al terminar`);
        holding = false; held = [];
        return out;
      }
      if (holding && (pduType2 === 2 || pduType2 === 27)) return hold(frame);
    }
    if (holding && frame[0] !== 0x03) return hold(frame); // fast-path
    return [frame];
  }
  function hold(frame) {
    held.push(frame);
    if (held.length <= 5000) return [];
    const out = held; // algo raro: no se retiene indefinidamente
    holding = false; held = [];
    return out;
  }
  // ShareControl de un TPKT de un único PDU (los agrupados ya vienen separados)
  function shareOf(frame) {
    if (frame[0] !== 0x03 || frame.length < 21 || frame[4] !== 0x02 || (frame[7] >> 2) !== 26) return null;
    let off = 13;
    off += frame[off] & 0x80 ? 2 : 1;
    const s = frame.subarray(off);
    return s.length >= 6 && s.readUInt16LE(0) === s.length && (s.readUInt16LE(2) & 0xfff0) === 0x0010 ? s : null;
  }

  return function transform(chunk) {
    if (broken) return chunk;
    if (!framed) {
      // El primer paquete TPKT con datos X.224 tras CredSSP es el MCS Connect Response
      if (chunk.length >= 7 && chunk[0] === 0x03 && chunk[1] === 0x00 && chunk[4] === 0x02 && chunk[5] === 0xf0 && chunk[6] === 0x80) framed = true;
      else return chunk;
    }
    buf = Buffer.concat([buf, chunk]);
    const out = [];
    while (buf.length >= 4) {
      let size;
      if (buf[0] === 0x03) size = buf.readUInt16BE(2);
      else if ((buf[0] & 0x03) === 0) size = buf[1] & 0x80 ? ((buf[1] & 0x7f) << 8) | buf[2] : buf[1];
      else { broken = true; log('rdp: tráfico no reconocido; se deja pasar sin cambios'); out.push(buf); buf = Buffer.alloc(0); break; }
      if (size < 2) { broken = true; out.push(buf); buf = Buffer.alloc(0); break; }
      if (buf.length < size) break;
      const frame = buf.subarray(0, size);
      buf = buf.subarray(size);
      if (frames++ < 60 && frame[0] === 0x03) log(`rdp: servidor → TPKT ${size} bytes`);
      if (frame[0] !== 0x03) describeFast(frame);
      for (const f of frame[0] === 0x03 ? splitSlowPath(frame) : [frame]) out.push(...stage(f));
    }
    return Buffer.concat(out);
  };
}

// Al entrar a la sesión, los Windows antiguos reactivan la conexión (Deactivate All + Demand Active) y
// repintan la pantalla mientras IronRDP todavía se está reactivando: esos gráficos se pierden y queda en negro.
// Al terminar cada (re)activación se pide al servidor un repintado completo (Refresh Rect, MS-RDPBCGR 2.2.11.2).
// Del tráfico del cliente sólo se leen cabeceras de PDU de datos y el tamaño del escritorio de Confirm Active.
function createRefresher(log) {
  let started = false;
  let cbuf = Buffer.alloc(0);
  let head = null;   // { mcs, src, shareId, stream, diff } copiado de un PDU de datos del cliente
  let size = null;   // escritorio acordado en Confirm Active
  let timer = null;

  function shareControlAt(f) {
    if (f.length < 20 || f[0] !== 0x03 || f[4] !== 0x02 || f[5] !== 0xf0 || f[6] !== 0x80 || (f[7] >> 2) !== 25) return -1;
    let off = 13;
    off += f[off] & 0x80 ? 2 : 1;
    return off + 6 <= f.length ? off : -1;
  }

  function inspect(f) {
    const off = shareControlAt(f);
    if (off < 0) return;
    const type = f.readUInt16LE(off + 2) & 0x0f;
    if (type === 7 && f.length >= off + 18) {
      head = { mcs: Buffer.from(f.subarray(7, 13)), src: f.readUInt16LE(off + 4), shareId: f.readUInt32LE(off + 6), stream: f[off + 11],
        diff: f.readUInt16LE(off) - f.readUInt16LE(off + 12) };
    } else if (type === 3 && f.length >= off + 16) {
      // Confirm Active: shareId(4) originator(2) lenSource(2) lenCaps(2) source numberCaps(2) pad(2) caps…
      let p = off + 6 + 4 + 2;
      const lenSource = f.readUInt16LE(p);
      p += 4 + lenSource + 4;
      while (p + 4 <= f.length) {
        const capType = f.readUInt16LE(p), capLen = f.readUInt16LE(p + 2);
        if (capLen < 4) break;
        if (capType === 2 && p + 16 <= f.length) { size = { w: f.readUInt16LE(p + 12), h: f.readUInt16LE(p + 14) }; break; }
        p += capLen;
      }
    }
  }

  function fromClient(chunk) {
    if (!started) {
      // el primer TPKT con datos X.224 tras CredSSP es el MCS Connect Initial
      if (chunk.length >= 7 && chunk[0] === 0x03 && chunk[1] === 0x00 && chunk[4] === 0x02 && chunk[5] === 0xf0 && chunk[6] === 0x80) started = true;
      else return;
    }
    if (!cbuf) return; // tráfico no reconocido: se desactiva
    cbuf = cbuf.length ? Buffer.concat([cbuf, chunk]) : chunk;
    while (cbuf.length >= 4) {
      let n;
      if (cbuf[0] === 0x03) n = cbuf.readUInt16BE(2);
      else if ((cbuf[0] & 0x03) === 0) n = cbuf[1] & 0x80 ? ((cbuf[1] & 0x7f) << 8) | cbuf[2] : cbuf[1];
      else n = 0;
      if (n < 2) { cbuf = null; head = null; return; }
      if (cbuf.length < n) break;
      inspect(cbuf.subarray(0, n));
      cbuf = cbuf.subarray(n);
    }
  }

  function refreshPdu() {
    const total = 30; // ShareControl(6) + ShareData(12) + numberOfAreas(1) pad(3) + rectángulo(8)
    const d = Buffer.alloc(total);
    d.writeUInt16LE(total, 0);
    d.writeUInt16LE(0x17, 2);
    d.writeUInt16LE(head.src, 4);
    d.writeUInt32LE(head.shareId, 6);
    d[11] = head.stream;
    d.writeUInt16LE(Math.max(0, total - head.diff), 12);
    d[14] = 33; // PDUTYPE2_REFRESH_RECT
    d[18] = 1;
    d.writeUInt16LE(0, 22); d.writeUInt16LE(0, 24);
    d.writeUInt16LE(size.w - 1, 26); d.writeUInt16LE(size.h - 1, 28);
    const body = Buffer.concat([Buffer.from([0x02, 0xf0, 0x80]), head.mcs, Buffer.from([total]), d]);
    const tpkt = Buffer.from([0x03, 0x00, 0, 0]);
    tpkt.writeUInt16BE(4 + body.length, 2);
    return Buffer.concat([tpkt, body]);
  }

  // write(buf) escribe hacia el servidor; sólo se inyecta en el límite entre paquetes del cliente
  function schedule(write, tries = 0) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!head || !size || cbuf === null) return log('rdp: sin datos para pedir repintado');
      if (cbuf.length && tries < 20) return schedule(write, tries + 1);
      if (cbuf.length) return;
      write(refreshPdu());
      log(`rdp: repintado completo solicitado (${size.w}x${size.h})`);
    }, tries ? 100 : 700);
  }

  return { fromClient, schedule, _refreshPdu: () => refreshPdu(), _state: () => ({ head, size }) };
}

// ---------------------------------------------------------------- servidor
// verifyCert(destination, fingerprint) => Promise<boolean>: confirma la huella con el usuario
// onEvent(token, kind): capacidades detectadas del servidor (ver createPduSplitter)
function createRdpProxy({ verifyCert, log = () => {}, onEvent = () => {} }) {
  const tickets = new Map(); // token -> { destination, expires }
  let wss = null;
  let port = 0;

  async function start() {
    if (wss) return port;
    wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise((res, rej) => { wss.once('listening', res); wss.once('error', rej); });
    port = wss.address().port;
    wss.on('connection', handle);
    return port;
  }

  async function ticket(destination) {
    await start();
    const token = crypto.randomBytes(24).toString('hex');
    tickets.set(token, { destination, expires: Date.now() + 60000 });
    return { proxyAddress: `ws://127.0.0.1:${port}`, token };
  }

  function handle(ws) {
    let buf = Buffer.alloc(0);
    let target = null;
    let started = false;
    const refresher = createRefresher(log);
    const fail =(e) => { try { ws.send(encodeError(e)); } catch { /* ignore */ } setTimeout(() => ws.close(), 200); };

    ws.on('message', async (data) => {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (target) { refresher.fromClient(chunk); return target.write(chunk); }
      if (started) { buf = Buffer.concat([buf, chunk]); return; }
      buf = Buffer.concat([buf, chunk]);
      const req = decodeRequest(buf);
      if (!req) return; // petición incompleta
      started = true;
      const rest = buf.subarray(req.total);
      buf = Buffer.alloc(0);
      const t = tickets.get(req.proxyAuth);
      tickets.delete(req.proxyAuth);
      if (req.version !== VERSION_1 || !t || t.expires < Date.now() || t.destination !== req.destination || !req.x224) {
        log('rdp: petición RDCleanPath rechazada');
        return fail({ code: 1 });
      }
      try {
        target = await connectTarget(req, rest);
      } catch (e) {
        log('rdp: ' + e.message);
        return fail(e.rdcp || { code: 1 });
      }
      if (buf.length) { refresher.fromClient(buf); target.write(buf); }
      buf = Buffer.alloc(0);
    });

    async function connectTarget(req, rest) {
      try {
        return await connectOnce(req, rest, TLS_MODERN);
      } catch (e) {
        // Los certificados autogenerados de Windows suelen no tener el uso «firma digital», que BoringSSL
        // exige con intercambio ECDHE. Se reintenta con intercambio RSA en TLS ≤1.2, como hace mstsc.
        if (!e.tlsKeyUsage) throw e;
        log('rdp: certificado sin «firma digital»; reintentando con intercambio de claves RSA');
        return connectOnce(req, rest, TLS_RSA);
      }
    }

    async function connectOnce(req, rest, tlsOpts) {
      const m = req.destination.match(/^\[?([^\]]+?)\]?:(\d+)$/);
      const host = m ? m[1] : req.destination;
      const p = m ? Number(m[2]) : 3389;
      const sock = await new Promise((resolve, reject) => {
        const s = net.connect({ host, port: p });
        s.setTimeout(15000, () => s.destroy(Object.assign(new Error('Tiempo de espera agotado'), { code: 'ETIMEDOUT' })));
        s.once('connect', () => { s.setTimeout(0); resolve(s); });
        s.once('error', (e) => reject(Object.assign(new Error(`No se pudo conectar a ${req.destination}: ${e.message}`), { rdcp: { code: e.code === 'ENOTFOUND' ? 104 : 103, wsa: WSA[e.code] } })));
      });
      sock.write(req.x224);
      const resp = await readTpkt(sock);
      // RDP_NEG_FAILURE (tipo 0x03) tras la cabecera TPKT (4) + X.224 CC (7)
      if (resp.length >= 12 && resp[11] === 0x03) {
        sock.destroy();
        throw Object.assign(new Error('El servidor rechazó la negociación de seguridad'), { rdcp: { code: 2, x224: resp } });
      }
      const secure = await new Promise((resolve, reject) => {
        const opts = { socket: sock, rejectUnauthorized: false, ...tlsOpts };
        if (net.isIP(host) === 0) opts.servername = host;
        const t = tls.connect(opts, () => resolve(t));
        t.once('error', (e) => {
          sock.destroy();
          reject(Object.assign(new Error('Falló el TLS con el servidor: ' + e.message), { rdcp: { code: 105 }, tlsKeyUsage: e.code === 'ERR_SSL_KEY_USAGE_BIT_INCORRECT' }));
        });
      });
      const chain = certChain(secure);
      if (!chain.length) throw Object.assign(new Error('El servidor no presentó certificado'), { rdcp: { code: 105 } });
      const fp = 'SHA256:' + crypto.createHash('sha256').update(chain[0]).digest('base64').replace(/=+$/, '');
      if (!(await verifyCert(req.destination, fp))) { secure.destroy(); throw Object.assign(new Error('Certificado rechazado por el usuario'), { rdcp: { code: 1 } }); }
      ws.send(encodeResponse(`${sock.remoteAddress}:${p}`, resp, chain));
      if (rest.length) secure.write(rest);
      const fixer = createPduSplitter(log, (kind) => {
        if (kind === 'fontMap') return refresher.schedule((b) => secure.write(b));
        log(`rdp: el servidor usa ${kind}`);
        onEvent(req.proxyAuth, kind);
      });
      secure.on('data', (d) => { const out = fixer(d); if (out.length && ws.readyState === ws.OPEN) ws.send(out); });
      secure.on('close', () => ws.close());
      secure.on('error', (e) => { log('rdp: ' + e.message); ws.close(); });
      ws.on('close', () => secure.destroy());
      return secure;
    }

    ws.on('close', () => { if (target) target.destroy(); });
    ws.on('error', () => { if (target) target.destroy(); });
  }

  function stop() { if (wss) { for (const c of wss.clients) c.terminate(); wss.close(); wss = null; port = 0; } }

  // Sesiones RDP abiertas en este momento (para confirmar el cierre de la app)
  const active = () => (wss ? [...wss.clients].filter((c) => c.readyState === c.OPEN).length : 0);

  return { ticket, stop, active, _codec: { decodeRequest, encodeResponse, encodeError, tlv, ctx, derInt, createPduSplitter, createRefresher } };
}

module.exports = { createRdpProxy };
