'use strict';
// Importador de sesiones de MobaXterm (.mxtsessions / MobaXterm.ini)
const crypto = require('crypto');

// Códigos de tipo de sesión usados por MobaXterm
const MOBA_TYPES = { 0: 'ssh', 1: 'telnet', 4: 'rdp', 6: 'ftp', 7: 'sftp', 8: 'serial', 10: 'local', 14: 'local' };
const DEFAULT_PORTS = { ssh: 22, sftp: 22, telnet: 23, rdp: 3389, ftp: 21 };
const BAUDS = [921600, 460800, 230400, 115200, 57600, 38400, 19200, 9600, 4800, 2400, 1200];

// MobaXterm mezcla líneas en UTF-8 y en Windows-1252: se decodifica línea a línea
const utf8 = new TextDecoder('utf-8', { fatal: true });
const ansi = new TextDecoder('windows-1252');

function decodeLine(bytes) {
  let text;
  try { text = utf8.decode(bytes); } catch { text = ansi.decode(bytes); }
  // Caracteres que MobaXterm ya perdió al exportar («Inserci�n», «Panam�»)
  return text.replace(/ci�n/g, 'ción').replace(/Panam�/g, 'Panamá').replace(/VI�A/g, 'VIÑA').replace(/Vi�a/g, 'Viña');
}

function decode(buf) {
  const lines = [];
  let start = 0;
  for (let i = 0; i <= buf.length; i++) {
    if (i === buf.length || buf[i] === 0x0a) { lines.push(decodeLine(buf.subarray(start, i))); start = i + 1; }
  }
  return lines.join('\n').replace(/^﻿/, '');
}

// MobaXterm guarda «[Nombre]» en el campo usuario cuando la sesión usa una credencial guardada
const credRef = (user) => {
  const m = /^\[(.+)\]$/.exec(user || '');
  return m ? m[1] : null;
};

function parseMobaXtermSessions(buf) {
  const text = decode(buf);
  const sessions = [];
  const skipped = [];
  const credentials = new Map(); // nombre -> usuario ('' si no se conoce)
  let folder = '';
  let section = '';

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';')) continue;
    const head = line.match(/^\[(.+)\]$/);
    if (head) { section = head[1]; folder = ''; continue; }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();

    // MobaXterm.ini: sólo se lee el nombre de usuario; la parte cifrada se descarta
    if (/^Credentials$/i.test(section)) {
      const user = value.split(':')[0];
      credentials.set(key, user);
      continue;
    }
    if (!/^Bookmarks(_\d+)?$/i.test(section)) continue;
    if (key === 'SubRep') { folder = value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''); continue; }
    if (key === 'ImgNum' || !value.startsWith('#')) continue;

    const parts = value.split('#');
    if (parts.length < 3) continue;
    const fields = parts[2].split('%');
    const code = Number(fields[0]);
    const type = MOBA_TYPES[code];
    if (!type) { skipped.push(key); continue; }

    const s = { id: crypto.randomUUID(), name: key, folder, type, importedFrom: 'MobaXterm' };
    if (type === 'local') {
      s.shell = code === 14 ? 'wsl' : 'powershell';
      if (code === 14 && fields[1]) s.wslDistro = fields[1];
    } else if (type === 'serial') {
      // El puerto aparece como «COM7  (descripción)»; la velocidad termina en un valor estándar
      const com = fields.map((f) => /^(COM\d+)\b/i.exec(f)).find(Boolean);
      s.serialPort = com ? com[1].toUpperCase() : '';
      s.baud = BAUDS.find((b) => String(fields[2] || '').endsWith(String(b))) || 9600;
      s.dataBits = 8; s.parity = 'none'; s.stopBits = 1; s.flow = 'none';
      if (!s.serialPort) { skipped.push(key); continue; }
    } else {
      s.host = fields[1] || '';
      s.port = Number(fields[2]) || DEFAULT_PORTS[type];
      const cred = credRef(fields[3]);
      if (cred) {
        s.credentialName = cred;
        s.user = '';
        if (!credentials.has(cred)) credentials.set(cred, '');
      } else {
        s.user = fields[3] || '';
      }
      if (type === 'ssh' || type === 'sftp') {
        s.auth = 'password';
        const key = fields.find((f) => /\.(ppk|pem|key)$|id_(rsa|ed25519|ecdsa)/i.test(f));
        if (key) {
          s.auth = 'key';
          s.keyPath = key.replace(/_ProfileDir_/g, process.env.USERPROFILE || '').replace(/_CurrentDrive_/g, 'C:');
        }
      }
    }
    if (type !== 'local' && type !== 'serial' && !s.host) { skipped.push(key); continue; }
    sessions.push(s);
  }
  return { sessions, skipped, credentials: [...credentials].map(([name, user]) => ({ name, user })) };
}

// Une los resultados de varios archivos (p. ej. .mxtsessions + MobaXterm.ini)
function mergeImports(results) {
  const sessions = [];
  const skipped = [];
  const creds = new Map();
  const seen = new Set();
  for (const r of results) {
    for (const s of r.sessions) {
      const k = [s.type, s.folder, s.name, s.host, s.port].join('|');
      if (!seen.has(k)) { seen.add(k); sessions.push(s); }
    }
    skipped.push(...r.skipped);
    for (const c of r.credentials) if (!creds.get(c.name)) creds.set(c.name, c.user);
  }
  return { sessions, skipped, credentials: [...creds].map(([name, user]) => ({ name, user })) };
}

// Archivo «Export to file» de la ventana de contraseñas de MobaXterm:
//   [protocolo:]usuario@servidor = contraseña   (contraseñas guardadas por sesión)
//   Nombre(usuario) = contraseña                (credenciales)
function parseMobaXtermPasswords(buf) {
  const credentials = [];
  const passwords = [];
  let skipped = 0;
  for (const line of decode(buf).split('\n')) {
    const text = line.replace(/\r$/, '');
    const eq = text.indexOf(' = ');
    if (eq < 0) { if (text.trim()) skipped++; continue; }
    const left = text.slice(0, eq).trim();
    const password = text.slice(eq + 3);
    const cred = /^(.*)\(([^()]*)\)$/.exec(left);
    const pass = /^(?:([a-z]+\d*):)?(.+)@([^@\s]+)$/i.exec(left);
    if (cred && cred[1].trim()) credentials.push({ name: cred[1].trim(), user: cred[2].trim(), password });
    else if (pass) passwords.push({ proto: (pass[1] || '').toLowerCase(), user: pass[2], host: pass[3].toLowerCase(), password });
    else skipped++;
  }
  return { credentials, passwords, skipped };
}

module.exports = { parseMobaXtermSessions, mergeImports, parseMobaXtermPasswords };
