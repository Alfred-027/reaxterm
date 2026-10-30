'use strict';
// ReaXTerm - proceso principal (Electron)
const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell, clipboard, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const dns = require('dns').promises;
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Client, utils: sshUtils } = require('ssh2');
const { parseMobaXtermSessions, mergeImports, parseMobaXtermPasswords } = require('./src/mobaimport');
const backup = require('./src/backup');
const { connectFtp } = require('./src/ftpfs');
const importers = require('./src/importers');
let SerialPort = null;
try { ({ SerialPort } = require('serialport')); } catch { /* puerto serie no disponible */ }

let pty = null;
try { pty = require('@lydell/node-pty'); } catch (err) { console.warn('node-pty no disponible:', err.message); }

const IS_WIN = process.platform === 'win32';
const SMOKE = process.argv.includes('--smoke');
// Las pruebas automáticas usan su propia carpeta de datos
if (SMOKE && process.env.REAXTERM_USERDATA) app.setPath('userData', process.env.REAXTERM_USERDATA);
if (SMOKE && process.env.REAXTERM_SMOKE_FILE) {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [process.env.REAXTERM_SMOKE_FILE] });
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: process.env.REAXTERM_SMOKE_FILE });
}
const DATA_FILE = () => path.join(app.getPath('userData'), 'reaxterm-data.json');

let win = null;
let forceQuit = false;
let data = {};
const conns = new Map();     // id de pestaña -> conexión activa
const cancelled = new Set(); // pestañas cerradas mientras conectaban
const tunnels = new Map();   // id de túnel -> runtime
const pending = new Map();   // respuestas a diálogos del renderer

// ---------------------------------------------------------------- utilidades
function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try { return { ok: true, value: await fn(...args) }; } catch (err) { return { ok: false, error: err.message || String(err) }; }
  });
}

const pcall = (fn) => new Promise((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v))));

function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE(), 'utf8')); } catch { return {}; }
}

function saveData() {
  const file = DATA_FILE();
  fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2));
  fs.renameSync(file + '.tmp', file);
}

function encrypt(str) {
  if (!str) return '';
  if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(str).toString('base64');
  return 'b64:' + Buffer.from(str, 'utf8').toString('base64');
}

function decrypt(str) {
  if (!str) return '';
  try {
    if (str.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(str.slice(4), 'base64'));
    if (str.startsWith('b64:')) return Buffer.from(str.slice(4), 'base64').toString('utf8');
  } catch { /* clave de otro equipo */ }
  return '';
}

// Pide algo al usuario a través de la interfaz (contraseña, clave de host...)
function ask(opts) {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    pending.set(id, resolve);
    send('ui:prompt', id, opts);
  });
}
ipcMain.on('ui:prompt-reply', (_e, id, value) => {
  const resolve = pending.get(id);
  if (resolve) { pending.delete(id); resolve(value); }
});

const stripAnsi = (s) => s
  .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
  .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
  .replace(/\x1b[()][0-9A-B]/g, '');

// ---------------------------------------------------------------- SSH
function hostVerifier(host, port) {
  return (key, verify) => {
    const fingerprint = 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
    const id = `${host}:${port}`;
    const known = data.knownHosts && data.knownHosts[id];
    if (known === fingerprint) return verify(true);
    ask({ kind: 'hostkey', host: id, fingerprint, changed: !!known, previous: known }).then((answer) => {
      if (answer === 'save') {
        data.knownHosts = { ...(data.knownHosts || {}), [id]: fingerprint };
        saveData();
      }
      verify(answer === 'save' || answer === 'once');
    });
  };
}

// Credencial guardada asociada a la sesión (gestor de credenciales)
function credentialFor(s) {
  return s && s.credentialId ? (data.credentials || []).find((c) => c.id === s.credentialId) || null : null;
}

// Guarda en la credencial lo que el usuario escribió al conectar, para no volver a pedirlo
function fillCredential(cred, fields) {
  if (!cred) return;
  let changed = false;
  if (fields.user && !cred.user) { cred.user = fields.user; changed = true; }
  if (fields.password && !cred.passwordEnc) { cred.passwordEnc = encrypt(fields.password); changed = true; }
  if (!changed) return;
  saveData();
  if (win && !win.isDestroyed()) win.webContents.send('store:changed', 'credentials', data.credentials);
}

async function sshConfig(s) {
  const port = Number(s.port) || 22;
  const cred = credentialFor(s);
  let username = cred ? cred.user : s.user;
  let typedUser = '';
  if (!username) {
    username = await ask({ kind: 'text', title: 'Usuario', message: cred ? `Usuario de la credencial «${cred.name}» (se guardará)` : `Usuario para ${s.host}` });
    if (!username) throw new Error('Conexión cancelada');
    typedUser = username;
  }
  const cfg = {
    host: s.host,
    port,
    username,
    readyTimeout: 25000,
    keepaliveInterval: (Number(s.keepalive) || 30) * 1000,
    keepaliveCountMax: 4,
    tryKeyboard: true,
    hostVerifier: hostVerifier(s.host, port),
  };
  let password = decrypt(cred ? cred.passwordEnc : s.passwordEnc);
  let typedPassword = '';
  if (s.auth === 'key') {
    if (!s.keyPath) throw new Error('No se indicó el archivo de clave privada');
    cfg.privateKey = fs.readFileSync(s.keyPath);
    let passphrase = decrypt(s.passphraseEnc);
    const parsed = sshUtils.parseKey(cfg.privateKey, passphrase || undefined);
    if (parsed instanceof Error && /passphrase/i.test(parsed.message)) {
      passphrase = await ask({ kind: 'password', title: 'Frase de paso', message: `Frase de paso para ${path.basename(s.keyPath)}` });
      if (passphrase == null) throw new Error('Conexión cancelada');
    } else if (parsed instanceof Error) {
      throw new Error('Clave privada no válida: ' + parsed.message);
    }
    if (passphrase) cfg.passphrase = passphrase;
  } else if (s.auth === 'agent') {
    cfg.agent = IS_WIN ? '\\\\.\\pipe\\openssh-ssh-agent' : process.env.SSH_AUTH_SOCK;
  } else {
    if (!password) {
      password = await ask({ kind: 'password', title: 'Contraseña', message: cred ? `Contraseña de la credencial «${cred.name}» (${username}) — se guardará cifrada` : `Contraseña para ${username}@${s.host}` });
      if (password == null) throw new Error('Conexión cancelada');
      typedPassword = password;
    }
    cfg.password = password;
  }
  return { cfg, password, cred, typed: { user: typedUser, password: typedPassword } };
}

async function connectSsh(s) {
  const built = await sshConfig(s);
  return new Promise((resolve, reject) => {
    const client = new Client();
    let ready = false;
    let kbdUsed = false;
    client.on('keyboard-interactive', async (_name, _instr, _lang, prompts, finish) => {
      if (prompts.length === 1 && built.password && !kbdUsed) { kbdUsed = true; return finish([built.password]); }
      const answers = [];
      for (const p of prompts) {
        answers.push((await ask({ kind: p.echo ? 'text' : 'password', title: 'Autenticación', message: p.prompt })) || '');
      }
      finish(answers);
    });
    client.once('ready', () => { ready = true; fillCredential(built.cred, built.typed); resolve(client); });
    client.on('error', (err) => { if (!ready) reject(err); });
    client.connect(built.cfg);
  });
}

function output(id, chunk) {
  send('term:data', id, chunk);
  const c = conns.get(id);
  if (c && c.log) c.log.write(stripAnsi(typeof chunk === 'string' ? chunk : chunk.toString('utf8')));
}

function status(id, state, text) { send('term:status', id, state, text); }

function closed(id, reason) {
  const c = conns.get(id);
  if (!c) return;
  conns.delete(id);
  cleanupConn(c);
  send('term:exit', id, reason);
}

function cleanupConn(c) {
  if (c.log) { c.log.end(); c.log = null; }
  for (const w of c.watchers || []) { try { w.close(); } catch { /* ignore */ } }
  c.watchers = [];
}

async function openSsh(id, s, size) {
  status(id, 'connecting', `Conectando a ${s.host}…`);
  const client = await connectSsh(s);
  if (cancelled.delete(id)) { client.end(); return; }
  const conn = { type: 'ssh', client, session: s, sftp: null, watchers: [] };
  conns.set(id, conn);
  client.on('error', (err) => output(id, `\r\n\x1b[31m${err.message}\x1b[0m\r\n`));
  client.on('close', () => closed(id, 'Conexión cerrada'));
  const stream = await new Promise((resolve, reject) => {
    client.shell({ term: 'xterm-256color', cols: size.cols, rows: size.rows }, (err, st) => (err ? reject(err) : resolve(st)));
  });
  conn.stream = stream;
  stream.on('data', (d) => output(id, d));
  stream.stderr.on('data', (d) => output(id, d));
  stream.on('close', () => client.end());
  if (s.startupCmd) setTimeout(() => stream.write(s.startupCmd + '\r'), 700);
  status(id, 'connected', `${client.config ? client.config.username : s.user}@${s.host}:${Number(s.port) || 22}`);
}

// ---------------------------------------------------------------- Terminal local
function findGitBash() {
  const candidates = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
  ];
  return candidates.find((p) => fs.existsSync(p));
}

function findPwsh() {
  const p = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
  return fs.existsSync(p) ? p : null;
}

function shellCommand(kind, s = {}) {
  if (!IS_WIN) return { file: process.env.SHELL || '/bin/bash', args: ['-l'] };
  const sysroot = process.env.SystemRoot || 'C:\\Windows';
  switch (kind) {
    case 'cmd': return { file: process.env.ComSpec || path.join(sysroot, 'System32', 'cmd.exe'), args: [] };
    case 'wsl': return { file: path.join(sysroot, 'System32', 'wsl.exe'), args: s.wslDistro ? ['-d', s.wslDistro] : [] };
    case 'gitbash': {
      const bash = findGitBash();
      if (!bash) throw new Error('Git Bash no está instalado');
      return { file: bash, args: ['--login', '-i'] };
    }
    case 'pwsh': return { file: findPwsh() || 'pwsh.exe', args: ['-NoLogo'] };
    default: return { file: path.join(sysroot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoLogo'] };
  }
}

function availableShells() {
  if (!IS_WIN) return [{ id: 'default', label: 'Shell del sistema' }];
  const sysroot = process.env.SystemRoot || 'C:\\Windows';
  const list = [{ id: 'powershell', label: 'Windows PowerShell' }, { id: 'cmd', label: 'Símbolo del sistema (CMD)' }];
  if (findPwsh()) list.push({ id: 'pwsh', label: 'PowerShell 7' });
  if (fs.existsSync(path.join(sysroot, 'System32', 'wsl.exe'))) list.push({ id: 'wsl', label: 'WSL (Linux)' });
  if (findGitBash()) list.push({ id: 'gitbash', label: 'Git Bash' });
  return list;
}

function openLocal(id, s, size) {
  if (!pty) throw new Error('El módulo de terminal local (node-pty) no está disponible. Ejecuta "npm install" en la carpeta de ReaXTerm.');
  const { file, args } = shellCommand(s.shell, s);
  const cwd = s.cwd && fs.existsSync(s.cwd) ? s.cwd : os.homedir();
  const p = pty.spawn(file, args, {
    name: 'xterm-256color', cols: size.cols, rows: size.rows, cwd,
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  });
  conns.set(id, { type: 'local', pty: p, session: s, watchers: [] });
  p.onData((d) => output(id, d));
  p.onExit(({ exitCode }) => closed(id, `Proceso finalizado (código ${exitCode})`));
  if (s.startupCmd) setTimeout(() => p.write(s.startupCmd + '\r'), 500);
  status(id, 'connected', `${path.basename(file)} — ${cwd}`);
}

// ---------------------------------------------------------------- Telnet
function telnetFilter(buf, sock) {
  const IAC = 255, DONT = 254, DO = 253, WONT = 252, WILL = 251, SB = 250, SE = 240;
  const out = [];
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b !== IAC) { out.push(b); continue; }
    const cmd = buf[++i];
    if (cmd === IAC) { out.push(IAC); continue; }
    if (cmd === DO || cmd === DONT || cmd === WILL || cmd === WONT) {
      const opt = buf[++i];
      if (cmd === DO) sock.write(Buffer.from([IAC, WONT, opt]));
      else if (cmd === WILL) sock.write(Buffer.from([IAC, opt === 1 || opt === 3 ? DO : DONT, opt]));
    } else if (cmd === SB) {
      while (i < buf.length && !(buf[i] === IAC && buf[i + 1] === SE)) i++;
      i++;
    }
  }
  return Buffer.from(out);
}

function openTelnet(id, s) {
  return new Promise((resolve, reject) => {
    status(id, 'connecting', `Conectando a ${s.host}…`);
    const port = Number(s.port) || 23;
    const sock = net.connect({ host: s.host, port });
    let ok = false;
    sock.setTimeout(15000, () => { if (!ok) sock.destroy(new Error('Tiempo de espera agotado')); });
    sock.once('connect', () => {
      ok = true;
      sock.setTimeout(0);
      if (cancelled.delete(id)) { sock.destroy(); return resolve(); }
      conns.set(id, { type: 'telnet', socket: sock, session: s, watchers: [] });
      status(id, 'connected', `telnet ${s.host}:${port}`);
      resolve();
    });
    sock.on('error', (err) => { if (!ok) reject(err); else output(id, `\r\n\x1b[31m${err.message}\x1b[0m\r\n`); });
    sock.on('close', () => closed(id, 'Conexión Telnet cerrada'));
    sock.on('data', (buf) => { const clean = telnetFilter(buf, sock); if (clean.length) output(id, clean); });
  });
}

// ---------------------------------------------------------------- SFTP y FTP sin terminal
async function openSftpOnly(id, s) {
  status(id, 'connecting', `Conectando a ${s.host}…`);
  const client = await connectSsh(s);
  if (cancelled.delete(id)) { client.end(); return; }
  conns.set(id, { type: 'ssh', client, session: s, sftp: null, watchers: [], filesOnly: true });
  client.on('error', (err) => send('app:toast', err.message, 'error'));
  client.on('close', () => closed(id, 'Conexión cerrada'));
  await getSftp(id);
  status(id, 'connected', `sftp ${client.config ? client.config.username : s.user}@${s.host}:${Number(s.port) || 22}`);
}

async function openFtp(id, s) {
  status(id, 'connecting', `Conectando a ${s.host}…`);
  const cred = credentialFor(s);
  const user = cred ? cred.user : s.user;
  let password = decrypt(cred ? cred.passwordEnc : s.passwordEnc);
  let typed = '';
  if (user && !password) {
    password = await ask({ kind: 'password', title: 'Contraseña', message: cred ? `Contraseña de la credencial «${cred.name}» (${user}) — se guardará cifrada` : `Contraseña FTP para ${user}@${s.host}` });
    if (password == null) throw new Error('Conexión cancelada');
    typed = password;
  }
  const port = Number(s.port) || 21;
  const fsx = await connectFtp({ host: s.host, port, user, password, secure: s.ftpSecure, insecure: s.ftpInsecure });
  if (cancelled.delete(id)) { fsx.end(); return; }
  fillCredential(cred, { password: typed });
  fsx.client.ftp.socket.on('close', () => closed(id, 'Conexión FTP cerrada'));
  conns.set(id, { type: 'ftp', fs: fsx, session: s, watchers: [], filesOnly: true });
  status(id, 'connected', `${s.ftpSecure ? 'ftps' : 'ftp'} ${user || 'anonymous'}@${s.host}:${port}`);
}

// ---------------------------------------------------------------- Puerto serie
function openSerial(id, s) {
  if (!SerialPort) throw new Error('El módulo de puerto serie no está disponible');
  if (!s.serialPort) throw new Error('No se indicó el puerto serie');
  return new Promise((resolve, reject) => {
    status(id, 'connecting', `Abriendo ${s.serialPort}…`);
    const port = new SerialPort({
      path: s.serialPort, baudRate: Number(s.baud) || 9600, dataBits: Number(s.dataBits) || 8,
      parity: s.parity || 'none', stopBits: Number(s.stopBits) || 1,
      rtscts: s.flow === 'rtscts', xon: s.flow === 'xonxoff', xoff: s.flow === 'xonxoff', autoOpen: false,
    });
    port.open((err) => {
      if (err) return reject(new Error(`No se pudo abrir ${s.serialPort}: ${err.message}`));
      if (cancelled.delete(id)) { port.close(); return resolve(); }
      conns.set(id, { type: 'serial', port, session: s, watchers: [] });
      port.on('data', (d) => output(id, d));
      port.on('error', (e) => output(id, `\r\n\x1b[31m${e.message}\x1b[0m\r\n`));
      port.on('close', () => closed(id, `Puerto ${s.serialPort} cerrado`));
      status(id, 'connected', `${s.serialPort} · ${port.baudRate} baudios`);
      resolve();
    });
  });
}

handle('term:serialPorts', async () => {
  if (!SerialPort) return [];
  return (await SerialPort.list()).map((p) => ({ path: p.path, label: [p.path, p.friendlyName || p.manufacturer].filter(Boolean).join(' — ') }));
});

// ---------------------------------------------------------------- IPC terminal
handle('term:open', async (id, s, size) => {
  cancelled.delete(id);
  if (s.type === 'ssh') await openSsh(id, s, size);
  else if (s.type === 'telnet') await openTelnet(id, s);
  else if (s.type === 'local') openLocal(id, s, size);
  else if (s.type === 'sftp') await openSftpOnly(id, s);
  else if (s.type === 'ftp') await openFtp(id, s);
  else if (s.type === 'serial') await openSerial(id, s);
  else throw new Error('Tipo de sesión no soportado: ' + s.type);
  return true;
});

ipcMain.on('term:write', (_e, id, d) => {
  const c = conns.get(id);
  if (!c) return;
  if (c.type === 'ssh' && c.stream) c.stream.write(d);
  else if (c.type === 'local') c.pty.write(d);
  else if (c.type === 'telnet') c.socket.write(d.replace(/\r(?!\n)/g, '\r\n'));
  else if (c.type === 'serial') c.port.write(d);
});

ipcMain.on('term:resize', (_e, id, cols, rows) => {
  const c = conns.get(id);
  if (!c || !cols || !rows) return;
  try {
    if (c.type === 'ssh' && c.stream) c.stream.setWindow(rows, cols, 0, 0);
    else if (c.type === 'local') c.pty.resize(cols, rows);
  } catch { /* proceso ya cerrado */ }
});

function closeConn(id) {
  const c = conns.get(id);
  if (!c) { cancelled.add(id); return; }
  conns.delete(id);
  cleanupConn(c);
  try {
    if (c.type === 'ssh') { if (c.stream) c.stream.end(); c.client.end(); }
    else if (c.type === 'local') c.pty.kill();
    else if (c.type === 'telnet') c.socket.destroy();
    else if (c.type === 'ftp') c.fs.end();
    else if (c.type === 'serial') c.port.close();
  } catch { /* ignore */ }
}
handle('term:close', (id) => closeConn(id));

handle('term:log', async (id, enable, title) => {
  const c = conns.get(id);
  if (!c) throw new Error('La sesión no está conectada');
  if (!enable) { if (c.log) c.log.end(); c.log = null; return null; }
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const safe = String(title || 'sesion').replace(/[^\w.-]+/g, '_');
  const res = await dialog.showSaveDialog(win, {
    title: 'Guardar registro de la sesión',
    defaultPath: path.join(app.getPath('documents'), `${safe}-${stamp}.log`),
    filters: [{ name: 'Registro', extensions: ['log', 'txt'] }],
  });
  if (res.canceled) return null;
  c.log = fs.createWriteStream(res.filePath, { flags: 'a' });
  return res.filePath;
});

// ---------------------------------------------------------------- SFTP
function getSftp(id) {
  const c = conns.get(id);
  if (c && c.type === 'ftp') return Promise.resolve(c.fs);
  if (!c || c.type !== 'ssh') return Promise.reject(new Error('Esta pestaña no es una sesión SSH conectada'));
  if (c.sftp) return Promise.resolve(c.sftp);
  return new Promise((resolve, reject) => c.client.sftp((err, sftp) => {
    if (err) return reject(err);
    c.sftp = sftp;
    sftp.on('close', () => { c.sftp = null; });
    resolve(sftp);
  }));
}

function modeString(mode) {
  const t = (mode & 0o170000) === 0o040000 ? 'd' : (mode & 0o170000) === 0o120000 ? 'l' : '-';
  const r = ['r', 'w', 'x'];
  let s = t;
  for (let i = 8; i >= 0; i--) s += mode & (1 << i) ? r[(8 - i) % 3] : '-';
  return s;
}

const isDirMode = (mode) => (mode & 0o170000) === 0o040000;

let transferSeq = 0;
function progress(name) {
  const tid = ++transferSeq;
  let last = 0;
  return {
    step: (done, _chunk, total) => {
      const now = Date.now();
      if (now - last > 150 || done === total) { last = now; send('sftp:progress', { tid, name, done, total }); }
    },
    finish: (error) => send('sftp:progress', { tid, name, finished: true, error }),
  };
}

async function sftpRemoveRecursive(sftp, target) {
  const list = await pcall((cb) => sftp.readdir(target, cb));
  for (const f of list) {
    const p = path.posix.join(target, f.filename);
    if (isDirMode(f.attrs.mode)) await sftpRemoveRecursive(sftp, p);
    else await pcall((cb) => sftp.unlink(p, cb));
  }
  await pcall((cb) => sftp.rmdir(target, cb));
}

async function sftpUploadPath(sftp, local, remoteDir) {
  const name = path.basename(local);
  const remote = path.posix.join(remoteDir, name);
  const st = fs.statSync(local);
  if (st.isDirectory()) {
    await pcall((cb) => sftp.mkdir(remote, cb)).catch(() => {});
    for (const child of fs.readdirSync(local)) await sftpUploadPath(sftp, path.join(local, child), remote);
  } else {
    const p = progress('↑ ' + name);
    try { await pcall((cb) => sftp.fastPut(local, remote, { step: p.step }, cb)); p.finish(); } catch (err) { p.finish(err.message); throw err; }
  }
}

async function sftpDownloadPath(sftp, remote, localDir, isDir) {
  const name = path.posix.basename(remote);
  const local = path.join(localDir, name);
  if (isDir) {
    fs.mkdirSync(local, { recursive: true });
    const list = await pcall((cb) => sftp.readdir(remote, cb));
    for (const f of list) await sftpDownloadPath(sftp, path.posix.join(remote, f.filename), local, isDirMode(f.attrs.mode));
  } else {
    const p = progress('↓ ' + name);
    try { await pcall((cb) => sftp.fastGet(remote, local, { step: p.step }, cb)); p.finish(); } catch (err) { p.finish(err.message); throw err; }
  }
}

handle('sftp:list', async (id, dir) => {
  const sftp = await getSftp(id);
  const real = await pcall((cb) => sftp.realpath(dir || '.', cb));
  const list = await pcall((cb) => sftp.readdir(real, cb));
  const entries = list.map((f) => ({
    name: f.filename,
    size: f.attrs.size,
    mtime: f.attrs.mtime * 1000,
    mode: f.attrs.mode,
    perms: modeString(f.attrs.mode),
    isDir: isDirMode(f.attrs.mode),
    isLink: (f.attrs.mode & 0o170000) === 0o120000,
  }));
  entries.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
  return { path: real, entries };
});

handle('sftp:stat', async (id, p) => {
  const sftp = await getSftp(id);
  const st = await pcall((cb) => sftp.stat(p, cb));
  return { isDir: isDirMode(st.mode), size: st.size };
});

handle('sftp:upload', async (id, remoteDir, localPaths) => {
  const sftp = await getSftp(id);
  let files = localPaths;
  if (!files || !files.length) {
    const res = await dialog.showOpenDialog(win, { title: 'Subir archivos', properties: ['openFile', 'multiSelections'] });
    if (res.canceled) return 0;
    files = res.filePaths;
  }
  for (const f of files) await sftpUploadPath(sftp, f, remoteDir);
  return files.length;
});

handle('sftp:download', async (id, items) => {
  const sftp = await getSftp(id);
  let target;
  if (items.length === 1 && !items[0].isDir) {
    const res = await dialog.showSaveDialog(win, { title: 'Descargar archivo', defaultPath: path.join(app.getPath('downloads'), path.posix.basename(items[0].path)) });
    if (res.canceled) return null;
    const p = progress('↓ ' + path.basename(res.filePath));
    try { await pcall((cb) => sftp.fastGet(items[0].path, res.filePath, { step: p.step }, cb)); p.finish(); } catch (err) { p.finish(err.message); throw err; }
    return res.filePath;
  }
  const res = await dialog.showOpenDialog(win, { title: 'Carpeta de destino', defaultPath: app.getPath('downloads'), properties: ['openDirectory', 'createDirectory'] });
  if (res.canceled) return null;
  target = res.filePaths[0];
  for (const it of items) await sftpDownloadPath(sftp, it.path, target, it.isDir);
  return target;
});

handle('sftp:delete', async (id, items) => {
  const sftp = await getSftp(id);
  for (const it of items) {
    if (it.isDir) await sftpRemoveRecursive(sftp, it.path);
    else await pcall((cb) => sftp.unlink(it.path, cb));
  }
  return true;
});

handle('sftp:rename', async (id, from, to) => { const sftp = await getSftp(id); await pcall((cb) => sftp.rename(from, to, cb)); return true; });
handle('sftp:mkdir', async (id, p) => { const sftp = await getSftp(id); await pcall((cb) => sftp.mkdir(p, cb)); return true; });
handle('sftp:chmod', async (id, p, mode) => { const sftp = await getSftp(id); await pcall((cb) => sftp.chmod(p, parseInt(mode, 8), cb)); return true; });
handle('sftp:touch', async (id, p) => { const sftp = await getSftp(id); await pcall((cb) => sftp.writeFile(p, '', { flag: 'a' }, cb)); return true; });

handle('sftp:readFile', async (id, p) => {
  const sftp = await getSftp(id);
  const st = await pcall((cb) => sftp.stat(p, cb));
  if (st.size > 5 * 1024 * 1024) throw new Error('El archivo supera 5 MB; usa «Abrir con editor externo» o descárgalo');
  const buf = await pcall((cb) => sftp.readFile(p, cb));
  return buf.toString('utf8');
});

handle('sftp:writeFile', async (id, p, content) => {
  const sftp = await getSftp(id);
  await pcall((cb) => sftp.writeFile(p, content, cb));
  return true;
});

// Descarga a temporal, abre con la app predeterminada y sube los cambios al guardar
handle('sftp:openExternal', async (id, remote) => {
  const sftp = await getSftp(id);
  const c = conns.get(id);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reaxterm-'));
  const local = path.join(dir, path.posix.basename(remote));
  await pcall((cb) => sftp.fastGet(remote, local, cb));
  let timer = null;
  let lastMtime = fs.statSync(local).mtimeMs;
  const watcher = fs.watch(local, () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const m = fs.statSync(local).mtimeMs;
        if (m === lastMtime) return;
        lastMtime = m;
        const s = await getSftp(id);
        await pcall((cb) => s.fastPut(local, remote, cb));
        send('app:toast', `Cambios subidos: ${path.posix.basename(remote)}`, 'ok');
      } catch (err) { send('app:toast', `No se pudo subir ${path.posix.basename(remote)}: ${err.message}`, 'error'); }
    }, 500);
  });
  c.watchers.push(watcher);
  const err = await shell.openPath(local);
  if (err) throw new Error(err);
  return local;
});

// ---------------------------------------------------------------- Túneles SSH
function tstatus(id, state, text) { send('tunnel:status', id, state, text); }

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(port), host, () => { server.removeListener('error', reject); resolve(); });
  });
}

function socksServer(client, rt) {
  return net.createServer((sock) => {
    rt.sockets.add(sock);
    sock.on('close', () => rt.sockets.delete(sock));
    sock.on('error', () => {});
    let buf = Buffer.alloc(0);
    let stage = 0;
    const fail = (code) => sock.end(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]));
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 0) {
        if (buf.length < 2) return;
        if (buf[0] !== 5) return sock.destroy();
        const n = buf[1];
        if (buf.length < 2 + n) return;
        sock.write(Buffer.from([5, 0]));
        buf = buf.subarray(2 + n);
        stage = 1;
      }
      if (stage === 1) {
        if (buf.length < 5) return;
        const atyp = buf[3];
        let host, off;
        if (atyp === 1) { if (buf.length < 10) return; host = [...buf.subarray(4, 8)].join('.'); off = 8; }
        else if (atyp === 3) { const l = buf[4]; if (buf.length < 7 + l) return; host = buf.subarray(5, 5 + l).toString(); off = 5 + l; }
        else if (atyp === 4) {
          if (buf.length < 22) return;
          const parts = [];
          for (let i = 0; i < 16; i += 2) parts.push(buf.readUInt16BE(4 + i).toString(16));
          host = parts.join(':'); off = 20;
        } else return fail(8);
        if (buf[1] !== 1) return fail(7);
        const port = buf.readUInt16BE(off);
        const rest = buf.subarray(off + 2);
        stage = 2;
        sock.removeListener('data', onData);
        sock.pause();
        client.forwardOut('127.0.0.1', 0, host, port, (err, stream) => {
          if (err) return fail(5);
          sock.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          if (rest.length) stream.write(rest);
          stream.on('error', () => sock.destroy());
          sock.pipe(stream).pipe(sock);
          sock.resume();
        });
      }
    };
    sock.on('data', onData);
  });
}

function stopTunnel(id, reason) {
  const rt = tunnels.get(id);
  if (!rt) return;
  tunnels.delete(id);
  for (const s of rt.servers) { try { s.close(); } catch { /* ignore */ } }
  for (const s of rt.sockets) s.destroy();
  try { rt.client.end(); } catch { /* ignore */ }
  tstatus(id, reason ? 'error' : 'stopped', reason || 'Detenido');
}

handle('tunnel:start', async (t, s) => {
  if (tunnels.has(t.id)) return true;
  tstatus(t.id, 'connecting', 'Conectando…');
  let client;
  try { client = await connectSsh(s); } catch (err) { tstatus(t.id, 'error', err.message); throw err; }
  const rt = { client, servers: [], sockets: new Set() };
  tunnels.set(t.id, rt);
  client.on('error', (err) => tstatus(t.id, 'error', err.message));
  client.on('close', () => { if (tunnels.has(t.id)) stopTunnel(t.id, 'Conexión SSH cerrada'); });
  const bind = t.bindAll ? '0.0.0.0' : '127.0.0.1';
  try {
    if (t.kind === 'local') {
      const srv = net.createServer((sock) => {
        rt.sockets.add(sock);
        sock.on('close', () => rt.sockets.delete(sock));
        sock.on('error', () => {});
        client.forwardOut(sock.remoteAddress || '127.0.0.1', sock.remotePort || 0, t.destHost, Number(t.destPort), (err, stream) => {
          if (err) return sock.destroy();
          stream.on('error', () => sock.destroy());
          sock.pipe(stream).pipe(sock);
        });
      });
      await listen(srv, t.listenPort, bind);
      rt.servers.push(srv);
      tstatus(t.id, 'running', `${bind}:${t.listenPort} → ${t.destHost}:${t.destPort}`);
    } else if (t.kind === 'dynamic') {
      const srv = socksServer(client, rt);
      await listen(srv, t.listenPort, bind);
      rt.servers.push(srv);
      tstatus(t.id, 'running', `SOCKS5 en ${bind}:${t.listenPort}`);
    } else if (t.kind === 'remote') {
      await pcall((cb) => client.forwardIn(bind, Number(t.listenPort), cb));
      client.on('tcp connection', (_info, accept) => {
        const stream = accept();
        const sock = net.connect(Number(t.destPort), t.destHost || '127.0.0.1');
        rt.sockets.add(sock);
        sock.on('close', () => rt.sockets.delete(sock));
        sock.on('error', () => stream.end());
        stream.on('error', () => sock.destroy());
        stream.pipe(sock).pipe(stream);
      });
      tstatus(t.id, 'running', `servidor:${t.listenPort} → ${t.destHost}:${t.destPort}`);
    }
  } catch (err) {
    stopTunnel(t.id, err.message);
    throw err;
  }
  return true;
});

handle('tunnel:stop', (id) => { stopTunnel(id); return true; });
handle('tunnel:list', () => [...tunnels.keys()]);

// ---------------------------------------------------------------- Herramientas
const validHost = (h) => /^[\w.\-:%]+$/.test(String(h || ''));

function streamCommand(runId, file, args) {
  const child = spawn(file, args, { windowsHide: true });
  const fwd = (d) => send('tools:output', runId, d.toString('utf8'));
  child.stdout.on('data', fwd);
  child.stderr.on('data', fwd);
  return new Promise((resolve) => child.on('close', (code) => { send('tools:output', runId, null); resolve(code); }));
}

handle('tools:ping', (runId, host) => {
  if (!validHost(host)) throw new Error('Host no válido');
  if (IS_WIN) return streamCommand(runId, 'cmd.exe', ['/d', '/c', `chcp 65001>nul & ping -n 4 ${host}`]);
  return streamCommand(runId, 'ping', ['-c', '4', host]);
});

handle('tools:trace', (runId, host) => {
  if (!validHost(host)) throw new Error('Host no válido');
  if (IS_WIN) return streamCommand(runId, 'cmd.exe', ['/d', '/c', `chcp 65001>nul & tracert -d -h 20 ${host}`]);
  return streamCommand(runId, 'traceroute', ['-n', '-m', '20', host]);
});

function checkPort(host, port, timeout = 2000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const sock = net.connect({ host, port: Number(port) });
    const done = (open) => { sock.destroy(); resolve({ port: Number(port), open, ms: Date.now() - start }); };
    sock.setTimeout(timeout, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

handle('tools:port', (host, port) => checkPort(host, port, 3000));

handle('tools:scan', async (runId, host, ports) => {
  const open = [];
  let i = 0, done = 0;
  const worker = async () => {
    while (i < ports.length) {
      const p = ports[i++];
      const r = await checkPort(host, p, 1200);
      done++;
      if (r.open) open.push(p);
      if (done % 10 === 0 || done === ports.length) send('tools:scan-progress', runId, done, ports.length, open.slice());
    }
  };
  await Promise.all(Array.from({ length: Math.min(64, ports.length) }, worker));
  return open.sort((a, b) => a - b);
});

handle('tools:dns', async (host) => {
  const res = { addresses: [], reverse: [] };
  try { res.addresses = (await dns.lookup(host, { all: true })).map((a) => `${a.address} (IPv${a.family})`); } catch (err) { res.error = err.message; }
  if (net.isIP(host)) { try { res.reverse = await dns.reverse(host); } catch { /* sin PTR */ } }
  return res;
});

handle('tools:netinfo', () => {
  const ifaces = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list) if (!a.internal) ifaces.push({ name, address: a.address, family: a.family, mac: a.mac, cidr: a.cidr });
  }
  return { hostname: os.hostname(), user: os.userInfo().username, platform: `${os.type()} ${os.release()}`, ifaces };
});

handle('tools:keygen', async (type, comment, passphrase) => {
  const opts = { comment: comment || `${os.userInfo().username}@${os.hostname()}` };
  if (type === 'rsa') opts.bits = 4096;
  if (passphrase) { opts.passphrase = passphrase; opts.cipher = 'aes256-ctr'; }
  const keys = sshUtils.generateKeyPairSync(type, opts);
  const defName = type === 'rsa' ? 'id_rsa' : type === 'ecdsa' ? 'id_ecdsa' : 'id_ed25519';
  const res = await dialog.showSaveDialog(win, { title: 'Guardar clave privada', defaultPath: path.join(os.homedir(), '.ssh', defName) });
  if (res.canceled) return { publicKey: keys.public };
  fs.mkdirSync(path.dirname(res.filePath), { recursive: true });
  fs.writeFileSync(res.filePath, keys.private, { mode: 0o600 });
  fs.writeFileSync(res.filePath + '.pub', keys.public + '\n');
  return { publicKey: keys.public, privatePath: res.filePath };
});

handle('launch:rdp', (s) => {
  if (!IS_WIN) throw new Error('RDP sólo está disponible en Windows');
  if (!validHost(s.host)) throw new Error('Host no válido');
  const cred = credentialFor(s);
  if (cred && cred.user) s = { ...s, user: cred.user };
  const lines = [
    `full address:s:${s.host}:${Number(s.port) || 3389}`,
    s.user ? `username:s:${s.user}` : '',
    `screen mode id:i:${s.rdpFullscreen ? 2 : 1}`,
    'prompt for credentials:i:1',
    'redirectclipboard:i:1',
    `redirectdrives:i:${s.rdpDrives ? 1 : 0}`,
  ].filter(Boolean);
  const file = path.join(os.tmpdir(), `reaxterm-${String(s.name || s.host).replace(/[^\w.-]+/g, '_')}.rdp`);
  fs.writeFileSync(file, lines.join('\r\n'));
  spawn('mstsc.exe', [file], { detached: true, stdio: 'ignore' }).unref();
  return true;
});

handle('launch:explorer', (p) => shell.openPath(p || os.homedir()));

// ---------------------------------------------------------------- Datos
handle('store:all', () => data);
handle('store:set', (key, value) => {
  if (['knownHosts', 'windowState'].includes(key)) throw new Error('Clave protegida');
  data[key] = value;
  saveData();
  return true;
});
handle('store:knownHosts', () => data.knownHosts || {});
handle('store:forgetHost', (host) => { if (data.knownHosts) delete data.knownHosts[host]; saveData(); return true; });
handle('secret:encrypt', (str) => encrypt(str));

// Respaldo completo (sesiones, credenciales con contraseñas, comandos, túneles, ajustes y
// servidores conocidos) cifrado con una contraseña elegida por el usuario
const SECRET_FIELDS = { sessions: ['passwordEnc', 'passphraseEnc'], credentials: ['passwordEnc'] };

function mapSecrets(payload, fn) {
  for (const [key, fields] of Object.entries(SECRET_FIELDS)) {
    payload[key] = (payload[key] || []).map((item) => {
      const out = { ...item };
      for (const f of fields) if (out[f]) out[f] = fn(out[f]);
      return out;
    });
  }
  return payload;
}

handle('data:export', async (password) => {
  if (!password || password.length < 8) throw new Error('La contraseña del respaldo debe tener al menos 8 caracteres');
  const stamp = new Date().toISOString().slice(0, 10);
  const res = await dialog.showSaveDialog(win, {
    title: 'Exportar configuración completa', defaultPath: path.join(app.getPath('documents'), `ReaXTerm-respaldo-${stamp}.rxbackup`),
    filters: [{ name: 'Respaldo ReaXTerm', extensions: ['rxbackup'] }],
  });
  if (res.canceled) return null;
  const { sessions, credentials, snippets, tunnels: tun, recent, settings, knownHosts } = data;
  // DPAPI sólo sirve en este equipo: las contraseñas viajan descifradas dentro del archivo cifrado
  const payload = mapSecrets({ sessions, credentials, snippets, tunnels: tun, recent, settings, knownHosts }, decrypt);
  fs.writeFileSync(res.filePath, JSON.stringify(backup.seal(payload, password), null, 2));
  return { file: res.filePath, sessions: (sessions || []).length, credentials: (credentials || []).length };
});

handle('data:import', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Importar configuración',
    filters: [{ name: 'Respaldo ReaXTerm', extensions: ['rxbackup', 'json'] }],
    properties: ['openFile'],
  });
  if (res.canceled) return null;
  const file = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf8'));
  if (!backup.isSealed(file)) return file; // respaldo antiguo sin cifrar (no trae contraseñas)
  let payload = null;
  for (let attempt = 0; !payload; attempt++) {
    const password = await ask({
      kind: 'password', title: 'Respaldo protegido',
      message: attempt ? 'Contraseña incorrecta. Vuelve a intentarlo:' : `Contraseña de «${path.basename(res.filePaths[0])}»`,
    });
    if (password == null) return null;
    try { payload = backup.open(file, password); } catch (e) { if (!e.wrongPassword || attempt >= 4) throw e; }
  }
  // Las contraseñas se vuelven a cifrar con DPAPI para este equipo
  mapSecrets(payload, encrypt);
  if (payload.knownHosts) { data.knownHosts = { ...payload.knownHosts, ...(data.knownHosts || {}) }; saveData(); }
  delete payload.knownHosts;
  return payload;
});

// Archivo «Export to file» de la ventana de contraseñas de MobaXterm (texto plano).
// Se lee aquí y las contraseñas salen ya cifradas con DPAPI.
handle('moba:importPasswords', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Importar contraseñas exportadas desde MobaXterm',
    defaultPath: path.join(app.getPath('downloads'), 'MobaXterm Stored Passwords.txt'),
    filters: [{ name: 'Contraseñas MobaXterm', extensions: ['txt'] }, { name: 'Todos', extensions: ['*'] }],
    properties: ['openFile'],
  });
  if (res.canceled) return null;
  const parsed = parseMobaXtermPasswords(fs.readFileSync(res.filePaths[0]));
  return {
    file: res.filePaths[0],
    credentials: parsed.credentials.map(({ password, ...c }) => ({ ...c, passwordEnc: encrypt(password) })),
    passwords: parsed.passwords.map(({ password, ...p }) => ({ ...p, passwordEnc: encrypt(password) })),
    skipped: parsed.skipped,
  };
});

handle('moba:deleteFile', async (file) => {
  if (!/\.txt$/i.test(file) || !fs.existsSync(file)) throw new Error('Archivo no válido');
  await shell.trashItem(file);
  return true;
});

handle('moba:import', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Importar sesiones de MobaXterm (puedes elegir también MobaXterm.ini para traer los usuarios)',
    filters: [{ name: 'Sesiones MobaXterm', extensions: ['mxtsessions', 'ini'] }, { name: 'Todos', extensions: ['*'] }],
    properties: ['openFile', 'multiSelections'],
  });
  if (res.canceled) return null;
  return mergeImports(res.filePaths.map((f) => parseMobaXtermSessions(fs.readFileSync(f))));
});

// Importación desde otros programas y archivos. Las contraseñas que traigan los archivos
// (CSV/JSON/Excel) se cifran aquí con DPAPI y nunca llegan en claro a la interfaz.
function sealImported(res, source) {
  let passwords = 0;
  for (const s of res.sessions) {
    if (s.plainPassword) { s.passwordEnc = encrypt(s.plainPassword); passwords++; }
    delete s.plainPassword;
  }
  return { ...res, source, passwords };
}

function exportRegistry(key) {
  const tmp = path.join(os.tmpdir(), `reaxterm-${crypto.randomUUID()}.reg`);
  return new Promise((resolve) => {
    require('child_process').execFile('reg.exe', ['export', key, tmp, '/y'], { windowsHide: true }, (err) => {
      if (err) return resolve('');
      try { resolve(fs.readFileSync(tmp, 'utf16le')); } catch { resolve(''); } finally { fs.rm(tmp, { force: true }, () => {}); }
    });
  });
}

async function parseImportFile(file) {
  const ext = path.extname(file).toLowerCase();
  const name = path.basename(file);
  const text = () => {
    const buf = fs.readFileSync(file);
    if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le').replace(/^﻿/, '');
    return buf.toString('utf8').replace(/^﻿/, '');
  };
  if (ext === '.mxtsessions' || (ext === '.ini' && /mobaxterm/i.test(name))) return parseMobaXtermSessions(fs.readFileSync(file));
  if (ext === '.reg') return importers.parsePuttyRegistry(text(), /kitty/i.test(text()) ? 'KiTTY' : 'PuTTY');
  if (ext === '.xml') return importers.parseMRemoteNG(text());
  if (ext === '.json') return importers.parseJson(text());
  if (ext === '.xlsx' || ext === '.xlsm') return importers.parseExcel(file);
  if (ext === '.xls') throw new Error(`«${name}» es Excel 97-2003: guárdalo como .xlsx o .csv`);
  if (ext === '.csv' || ext === '.tsv') return importers.sessionsFromRows(importers.parseCsv(text()), 'CSV');
  if (ext === '.rdp') return importers.parseRdpFile(text(), name);
  if (!ext || ext === '.conf' || ext === '.config') return importers.parseSshConfig(text());
  throw new Error(`Formato no reconocido: ${name}`);
}

handle('data:importSessions', async (kind) => {
  if (kind === 'putty') {
    const results = [];
    for (const [key, src] of [['HKCU\\Software\\SimonTatham\\PuTTY\\Sessions', 'PuTTY'], ['HKCU\\Software\\9bis.com\\KiTTY\\Sessions', 'KiTTY']]) {
      const reg = await exportRegistry(key);
      if (reg) results.push(importers.parsePuttyRegistry(reg, src));
    }
    if (!results.length) throw new Error('No se encontraron sesiones de PuTTY ni KiTTY en este equipo');
    return sealImported(mergeImports(results), 'PuTTY');
  }
  if (kind === 'sshconfig') {
    const file = path.join(os.homedir(), '.ssh', 'config');
    if (!fs.existsSync(file)) throw new Error(`No existe ${file}`);
    return sealImported(importers.parseSshConfig(fs.readFileSync(file, 'utf8')), 'OpenSSH');
  }
  const res = await dialog.showOpenDialog(win, {
    title: 'Importar sesiones',
    filters: [
      { name: 'Todos los formatos', extensions: ['csv', 'tsv', 'json', 'xlsx', 'xlsm', 'xml', 'reg', 'rdp', 'mxtsessions', 'ini', 'conf', 'config'] },
      { name: 'Tablas (CSV, Excel, JSON)', extensions: ['csv', 'tsv', 'xlsx', 'xlsm', 'json'] },
      { name: 'mRemoteNG (confCons.xml)', extensions: ['xml'] },
      { name: 'PuTTY / KiTTY exportado (.reg)', extensions: ['reg'] },
      { name: 'Escritorio remoto (.rdp)', extensions: ['rdp'] },
      { name: 'Todos los archivos', extensions: ['*'] },
    ],
    properties: ['openFile', 'multiSelections', 'showHiddenFiles'],
  });
  if (res.canceled) return null;
  const results = [];
  for (const f of res.filePaths) results.push(await parseImportFile(f));
  const merged = mergeImports(results);
  const kinds = [...new Set(results.flatMap((r) => r.sessions.map((s) => s.importedFrom)).filter(Boolean))];
  return sealImported(merged, kinds.join(', ') || 'Archivo');
});

handle('dialog:openFile', async (title) => {
  const res = await dialog.showOpenDialog(win, { title, defaultPath: path.join(os.homedir(), '.ssh'), properties: ['openFile', 'showHiddenFiles'] });
  return res.canceled ? null : res.filePaths[0];
});

handle('dialog:openDir', async (title) => {
  const res = await dialog.showOpenDialog(win, { title, properties: ['openDirectory'] });
  return res.canceled ? null : res.filePaths[0];
});

handle('clip:write', (text) => { clipboard.writeText(text); return true; });
handle('clip:read', () => clipboard.readText());

handle('app:info', () => ({
  version: app.getVersion(), electron: process.versions.electron, node: process.versions.node,
  platform: process.platform, ptyAvailable: !!pty, dataPath: app.getPath('userData'),
  shells: availableShells(), home: os.homedir(),
}));
handle('app:openData', () => shell.openPath(app.getPath('userData')));
handle('app:titlebar', (color, symbolColor) => {
  if (IS_WIN && win) win.setTitleBarOverlay({ color, symbolColor, height: 40 });
  return true;
});
handle('app:fullscreen', () => { win.setFullScreen(!win.isFullScreen()); return win.isFullScreen(); });
handle('app:quit', () => { forceQuit = true; win.close(); return true; });

// ---------------------------------------------------------------- Ventana
// El .exe es el de Electron sin modificar: el ícono de la barra de tareas se toma de icon.ico
const APP_ID = 'cl.rea.reaxterm';
const ICON_ICO = app.isPackaged ? path.join(process.resourcesPath, 'icon.ico') : path.join(__dirname, 'assets', 'icon.ico');
if (IS_WIN) app.setAppUserModelId(APP_ID);

function createWindow() {
  const st = data.windowState || {};
  win = new BrowserWindow({
    width: st.width || 1420,
    height: st.height || 880,
    x: st.x, y: st.y,
    minWidth: 960, minHeight: 600,
    title: 'ReaXTerm',
    backgroundColor: '#0d1017',
    icon: IS_WIN && fs.existsSync(ICON_ICO) ? ICON_ICO : path.join(__dirname, 'assets', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: IS_WIN ? { color: '#0d1017', symbolColor: '#c9d1e0', height: 40 } : undefined,
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  if (st.maximized) win.maximize();
  if (IS_WIN && fs.existsSync(ICON_ICO)) {
    // En la versión portable se ancla el .exe original, no la copia temporal que se ejecuta
    const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    win.setAppDetails({ appId: APP_ID, appIconPath: ICON_ICO, appIconIndex: 0, relaunchCommand: `"${exe}"`, relaunchDisplayName: 'ReaXTerm' });
  }
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => { if (!SMOKE) win.show(); });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });

  win.on('close', (e) => {
    const b = win.getNormalBounds();
    data.windowState = { ...b, maximized: win.isMaximized() };
    try { saveData(); } catch { /* ignore */ }
    if (!forceQuit && conns.size) { e.preventDefault(); send('app:request-close', conns.size); }
  });

  if (SMOKE) {
    win.webContents.on('console-message', (_e, level, message) => console.log(`[renderer:${level}] ${message}`));
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      if (process.env.REAXTERM_SMOKE_JS) {
        const r = await win.webContents.executeJavaScript(process.env.REAXTERM_SMOKE_JS).catch((e) => console.log('SMOKE_JS_ERROR', e.message));
        if (r !== undefined) console.log('SMOKE_RESULT', typeof r === 'string' ? r : JSON.stringify(r));
        await new Promise((r) => setTimeout(r, Number(process.env.REAXTERM_SMOKE_WAIT) || 4000));
      }
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(os.tmpdir(), 'reaxterm-smoke.png'), img.toPNG());
      console.log('SMOKE_OK', path.join(os.tmpdir(), 'reaxterm-smoke.png'));
      forceQuit = true;
      app.quit();
    }, 2500));
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    data = loadData();
    createWindow();
  });
  app.on('before-quit', () => {
    for (const id of [...conns.keys()]) closeConn(id);
    for (const id of [...tunnels.keys()]) stopTunnel(id);
  });
  app.on('window-all-closed', () => app.quit());
}
