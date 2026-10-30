'use strict';
// Importadores de sesiones: PuTTY/KiTTY, mRemoteNG, OpenSSH config, archivos .rdp,
// y tablas genéricas (CSV, JSON, Excel) con columnas reconocidas por nombre.
const crypto = require('crypto');

const newSession = (fields) => ({ id: crypto.randomUUID(), importedFrom: fields.importedFrom, ...fields });
const DEFAULT_PORTS = { ssh: 22, sftp: 22, telnet: 23, rdp: 3389, ftp: 21 };

// ---------------------------------------------------------------- PuTTY / KiTTY
// Acepta la salida de «reg query … /s» o un archivo .reg exportado
function parsePuttyRegistry(text, source = 'PuTTY') {
  const sessions = [];
  const skipped = [];
  const blocks = new Map();
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const key = line.match(/^\[?HKEY_[^\]]*\\Sessions\\([^\]\\]+)\]?$/i);
    if (key) { cur = {}; blocks.set(decodeURIComponent(key[1].replace(/%(?![0-9a-f]{2})/gi, '%25')), cur); continue; }
    if (!cur) continue;
    let m = line.match(/^(\S+)\s+REG_(SZ|DWORD|EXPAND_SZ)\s*(.*)$/); // reg query
    if (m) { cur[m[1]] = m[2] === 'DWORD' ? parseInt(m[3], 16) : m[3]; continue; }
    m = line.match(/^"([^"]+)"=(?:"((?:[^"\\]|\\.)*)"|dword:([0-9a-f]+))$/i); // .reg
    if (m) cur[m[1]] = m[3] != null ? parseInt(m[3], 16) : m[2].replace(/\\(.)/g, '$1');
  }
  for (const [name, v] of blocks) {
    const proto = String(v.Protocol || 'ssh').toLowerCase();
    if (proto === 'serial') {
      if (!v.SerialLine) { skipped.push(name); continue; }
      sessions.push(newSession({ name, folder: source, type: 'serial', serialPort: String(v.SerialLine).toUpperCase(), baud: v.SerialSpeed || 9600, dataBits: v.SerialDataBits || 8, parity: 'none', stopBits: 1, flow: 'none', importedFrom: source }));
      continue;
    }
    if (!v.HostName || !['ssh', 'telnet'].includes(proto)) { skipped.push(name); continue; }
    let host = String(v.HostName);
    let user = v.UserName || '';
    if (!user && host.includes('@')) [user, host] = [host.slice(0, host.lastIndexOf('@')), host.slice(host.lastIndexOf('@') + 1)];
    const s = newSession({ name, folder: source, type: proto, host, port: Number(v.PortNumber) || DEFAULT_PORTS[proto], user, importedFrom: source });
    if (proto === 'ssh') { s.auth = v.PublicKeyFile ? 'key' : 'password'; if (v.PublicKeyFile) s.keyPath = v.PublicKeyFile; }
    sessions.push(s);
  }
  return { sessions, skipped, credentials: [] };
}

// ---------------------------------------------------------------- mRemoteNG (confCons.xml)
const xmlDecode = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/&amp;/g, '&');
const attrs = (tag) => { const o = {}; for (const m of tag.matchAll(/([\w:-]+)="([^"]*)"/g)) o[m[1]] = xmlDecode(m[2]); return o; };
const MREMOTE_TYPES = { SSH1: 'ssh', SSH2: 'ssh', Telnet: 'telnet', RDP: 'rdp' };

function parseMRemoteNG(text) {
  const root = attrs((text.match(/<(?:mrng:)?Connections\b[^>]*>/) || [''])[0]);
  if (/true/i.test(root.FullFileEncryption || '')) throw new Error('El archivo de mRemoteNG está cifrado completo. En mRemoteNG desactiva «Cifrado completo del archivo» o exporta las conexiones como CSV.');
  const sessions = [];
  const skipped = [];
  const stack = [];
  for (const m of text.matchAll(/<(\/?)Node\b([^>]*?)(\/?)>/g)) {
    if (m[1]) { stack.pop(); continue; }
    const a = attrs(m[2]);
    const selfClosing = !!m[3];
    if (a.Type === 'Container') { if (!selfClosing) stack.push(a.Name || ''); continue; }
    const type = MREMOTE_TYPES[a.Protocol];
    if (!type || !a.Hostname) skipped.push(a.Name || a.Hostname || '?');
    else {
      const user = type === 'rdp' && a.Domain && a.Username ? `${a.Domain}\\${a.Username}` : a.Username || '';
      sessions.push(newSession({ name: a.Name || a.Hostname, folder: stack.filter(Boolean).join('/'), type, host: a.Hostname, port: Number(a.Port) || DEFAULT_PORTS[type], user, notes: a.Descr || '', auth: type === 'ssh' ? 'password' : undefined, importedFrom: 'mRemoteNG' }));
    }
    if (!selfClosing) stack.push(null); // conexión con hijos (raro): mantiene la pila equilibrada
  }
  return { sessions, skipped, credentials: [] };
}

// ---------------------------------------------------------------- OpenSSH config
function parseSshConfig(text) {
  const sessions = [];
  const skipped = [];
  let cur = null;
  const flush = () => { if (cur) { if (cur.host) sessions.push(cur); } cur = null; };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^(\w+)\s*=?\s*(.+)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim().replace(/^"(.*)"$/, '$1');
    if (key === 'host') {
      flush();
      const alias = val.split(/\s+/)[0];
      if (/[*?!]/.test(alias)) { skipped.push(alias); continue; }
      cur = newSession({ name: alias, folder: 'SSH config', type: 'ssh', host: alias, port: 22, user: '', auth: 'password', importedFrom: 'OpenSSH' });
    } else if (key === 'match') { flush(); }
    else if (cur) {
      if (key === 'hostname') cur.host = val;
      else if (key === 'port') cur.port = Number(val) || 22;
      else if (key === 'user') cur.user = val;
      else if (key === 'identityfile') { cur.auth = 'key'; cur.keyPath = val.replace(/^~/, process.env.USERPROFILE || process.env.HOME || '~'); }
    }
  }
  flush();
  return { sessions, skipped, credentials: [] };
}

// ---------------------------------------------------------------- archivos .rdp
function parseRdpFile(text, fileName) {
  const get = (k) => { const m = text.match(new RegExp(`^${k}:s:(.*)$`, 'mi')); return m ? m[1].trim() : ''; };
  const addr = get('full address');
  if (!addr) return { sessions: [], skipped: [fileName], credentials: [] };
  const mm = addr.match(/^\[?([^\]]+?)\]?(?::(\d+))?$/);
  const name = fileName.replace(/\.rdp$/i, '');
  return { sessions: [newSession({ name, folder: 'RDP', type: 'rdp', host: mm[1], port: Number(mm[2]) || 3389, user: get('username'), importedFrom: 'Archivo .rdp' })], skipped: [], credentials: [] };
}

// ---------------------------------------------------------------- tablas genéricas
const norm = (k) => String(k).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const ALIASES = {
  name: ['name', 'nombre', 'session', 'sesion', 'sessionname', 'label', 'title', 'alias', 'displayname', 'connectionname'],
  host: ['host', 'hostname', 'ip', 'ipaddress', 'address', 'direccion', 'server', 'servidor', 'hostip', 'fqdn', 'remotehost'],
  port: ['port', 'puerto'],
  user: ['user', 'username', 'usuario', 'login', 'loginname', 'userid'],
  domain: ['domain', 'dominio'],
  type: ['type', 'protocol', 'protocolo', 'tipo', 'connectiontype'],
  folder: ['folder', 'carpeta', 'group', 'grupo', 'path', 'ruta', 'parent', 'container', 'directory', 'category', 'categoria'],
  notes: ['notes', 'notas', 'note', 'description', 'descripcion', 'descr', 'comment', 'comentario', 'comments'],
  password: ['password', 'contrasena', 'clave', 'pass', 'pwd'],
  keyPath: ['keyfile', 'key', 'identityfile', 'privatekey', 'privatekeyfile', 'publickeyfile'],
  serialPort: ['serialport', 'comport', 'com', 'serialline'],
  baud: ['baud', 'baudrate', 'speed', 'velocidad'],
};
const FIELD_OF = new Map(Object.entries(ALIASES).flatMap(([f, list]) => list.map((a) => [a, f])));

function protocolOf(v, port) {
  const p = norm(v || '');
  if (/^ssh/.test(p)) return 'ssh';
  if (p === 'sftp' || p === 'scp') return 'sftp';
  if (p === 'ftp' || p === 'ftps') return 'ftp';
  if (p === 'telnet') return 'telnet';
  if (/^(rdp|remotedesktop|mstsc|escritorioremoto)/.test(p)) return 'rdp';
  if (/^(serial|serie|com)/.test(p)) return 'serial';
  if (p) return null; // protocolo desconocido (VNC, HTTP…)
  return { 3389: 'rdp', 23: 'telnet', 21: 'ftp' }[Number(port)] || 'ssh';
}

// Convierte filas {columna: valor} en sesiones. Las contraseñas se devuelven aparte (en claro)
// para que el proceso principal las cifre antes de enviarlas a la interfaz.
function sessionsFromRows(rows, source) {
  const sessions = [];
  const skipped = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = {};
    const hosts = [];
    for (const [k, v] of Object.entries(row)) {
      const f = FIELD_OF.get(norm(k));
      if (!f || v == null || String(v).trim() === '') continue;
      const val = typeof v === 'object' && v.text ? v.text : v;
      if (f === 'host') hosts.push(String(val).trim());
      else if (r[f] == null) r[f] = val;
    }
    // Con varias columnas tipo «Host» e «IP», se usa la que parece dirección y la otra como nombre
    if (hosts.length) {
      const looksAddr = (x) => /^[\d.]+$|[.:]/.test(x);
      r.host = hosts.find(looksAddr) || hosts[0];
      if (r.name == null) r.name = hosts.find((x) => x !== r.host);
    }
    const type = protocolOf(r.type, r.port);
    if (!type || (type === 'serial' ? !r.serialPort : !r.host)) { skipped.push(String(r.name || r.host || '?')); continue; }
    const s = newSession({ name: String(r.name || r.host || r.serialPort).trim(), folder: String(r.folder || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''), type, importedFrom: source });
    if (type === 'serial') Object.assign(s, { serialPort: String(r.serialPort).toUpperCase(), baud: Number(r.baud) || 9600, dataBits: 8, parity: 'none', stopBits: 1, flow: 'none' });
    else {
      s.host = String(r.host).trim();
      s.port = Number(r.port) || DEFAULT_PORTS[type];
      s.user = String(r.user || '').trim();
      if (type === 'rdp' && r.domain && s.user && !s.user.includes('\\')) s.user = `${r.domain}\\${s.user}`;
      if (type === 'ssh' || type === 'sftp') { s.auth = r.keyPath ? 'key' : 'password'; if (r.keyPath) s.keyPath = String(r.keyPath); }
      if (type === 'ftp' && /ftps/i.test(String(r.type || ''))) s.ftpSecure = true;
    }
    if (r.notes) s.notes = String(r.notes);
    if (r.password) s.plainPassword = String(r.password);
    sessions.push(s);
  }
  return { sessions, skipped, credentials: [] };
}

function parseCsv(text) {
  const first = text.split(/\r?\n/, 1)[0];
  const delim = [';', '\t', ','].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [''];
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { row[row.length - 1] += '"'; i++; }
      else if (ch === '"') q = false;
      else row[row.length - 1] += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) row.push('');
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; rows.push(row); row = ['']; }
    else row[row.length - 1] += ch;
  }
  if (row.length > 1 || row[0]) rows.push(row);
  const head = (rows.shift() || []).map((x) => x.trim());
  return rows.filter((r) => r.some((c) => c.trim())).map((r) => Object.fromEntries(head.map((k, i) => [k, r[i]])));
}

function parseJson(text) {
  const data = JSON.parse(text);
  if (data && data.format === 'reaxterm-backup') throw new Error('Es un respaldo cifrado de ReaXTerm: usa «Importar configuración».');
  const rows = Array.isArray(data) ? data : data.sessions || data.connections || data.hosts || data.items || [];
  if (!Array.isArray(rows)) throw new Error('No se encontró una lista de sesiones en el JSON');
  // Formato propio de ReaXTerm: se conservan los campos tal cual
  if (rows.length && rows.every((r) => r && r.type && (r.host || r.type === 'local' || r.type === 'serial') && TYPES_OK.has(r.type))) {
    const sessions = rows.map((r) => { const s = { ...r, id: crypto.randomUUID(), importedFrom: 'JSON' }; delete s.passwordEnc; delete s.passphraseEnc; if (r.password) s.plainPassword = String(r.password); delete s.password; delete s.credentialId; return s; });
    return { sessions, skipped: [], credentials: [] };
  }
  return sessionsFromRows(rows, 'JSON');
}
const TYPES_OK = new Set(['ssh', 'sftp', 'ftp', 'telnet', 'rdp', 'serial', 'local']);

async function parseExcel(file) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const all = [];
  wb.eachSheet((ws) => {
    let head = null;
    ws.eachRow({ includeEmpty: false }, (row) => {
      const vals = row.values.slice(1).map((v) => (v && typeof v === 'object' ? v.text || v.result || (v.richText ? v.richText.map((t) => t.text).join('') : '') : v));
      if (!head) { head = vals.map((v) => String(v || '').trim()); return; }
      const obj = Object.fromEntries(head.map((k, i) => [k, vals[i]]));
      // Si la columna de carpeta falta, la hoja hace de carpeta
      if (!head.some((k) => FIELD_OF.get(norm(k)) === 'folder') && wb.worksheets.length > 1) obj.folder = ws.name;
      all.push(obj);
    });
  });
  return sessionsFromRows(all, 'Excel');
}

module.exports = { parsePuttyRegistry, parseMRemoteNG, parseSshConfig, parseRdpFile, parseCsv, parseJson, parseExcel, sessionsFromRows };
