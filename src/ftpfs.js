'use strict';
// Adaptador FTP/FTPS con la misma interfaz (callbacks) que el cliente SFTP de ssh2,
// para que el explorador de archivos funcione igual con ambos protocolos.
const fs = require('fs');
const path = require('path');
const { Readable, Writable } = require('stream');
const ftp = require('basic-ftp');

const TYPE_BITS = { 1: 0o100000, 2: 0o040000, 3: 0o120000 };

function toAttrs(f) {
  const p = f.permissions;
  const perms = p ? (p.user << 6) | (p.group << 3) | p.world : (f.type === 2 ? 0o755 : 0o644);
  const mtime = f.modifiedAt ? f.modifiedAt.getTime() : Date.parse(f.rawModifiedAt) || 0;
  return { size: f.size || 0, mtime: Math.floor(mtime / 1000), mode: (TYPE_BITS[f.type] || 0o100000) | perms };
}

class FtpFs {
  constructor(client) {
    this.client = client;
    this.queue = Promise.resolve();
  }

  // basic-ftp no admite órdenes simultáneas: se encolan
  run(fn) {
    const p = this.queue.then(() => fn(this.client));
    this.queue = p.catch(() => {});
    return p;
  }

  done(p, cb) { p.then((v) => cb(null, v), (e) => cb(e)); }

  realpath(p, cb) {
    this.done(this.run(async (c) => {
      // Algunos servidores en Windows responden «\» o rutas con barras invertidas
      const cwd = (await c.pwd()).replace(/\\/g, '/') || '/';
      if (!p || p === '.') return cwd;
      return path.posix.normalize(p.startsWith('/') ? p : path.posix.join(cwd, p));
    }), cb);
  }

  readdir(p, cb) {
    this.done(this.run(async (c) => (await c.list(p))
      .filter((f) => f.name !== '.' && f.name !== '..')
      .map((f) => ({ filename: f.name, attrs: toAttrs(f) }))), cb);
  }

  stat(p, cb) {
    this.done(this.run(async (c) => {
      if (p === '/') return { size: 0, mode: 0o040755 };
      const name = path.posix.basename(p);
      const entry = (await c.list(path.posix.dirname(p))).find((f) => f.name === name);
      if (!entry) throw new Error('No existe: ' + p);
      return toAttrs(entry);
    }), cb);
  }

  fastPut(local, remote, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    const total = fs.statSync(local).size;
    this.done(this.run(async (c) => {
      if (opts.step) c.trackProgress((info) => opts.step(info.bytes, 0, total));
      try { await c.uploadFrom(local, remote); } finally { c.trackProgress(); }
    }), cb);
  }

  fastGet(remote, local, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    this.done(this.run(async (c) => {
      const total = await c.size(remote).catch(() => 0);
      if (opts.step) c.trackProgress((info) => opts.step(info.bytes, 0, total));
      try { await c.downloadTo(local, remote); } finally { c.trackProgress(); }
    }), cb);
  }

  unlink(p, cb) { this.done(this.run((c) => c.remove(p)), cb); }
  rmdir(p, cb) { this.done(this.run((c) => c.removeEmptyDir(p)), cb); }
  mkdir(p, cb) { this.done(this.run((c) => c.send('MKD ' + p)), cb); }
  rename(from, to, cb) { this.done(this.run((c) => c.rename(from, to)), cb); }
  chmod(p, mode, cb) { this.done(this.run((c) => c.send(`SITE CHMOD ${mode.toString(8)} ${p}`)), cb); }

  writeFile(p, content, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    const src = () => Readable.from([Buffer.from(content)]);
    this.done(this.run((c) => (opts && opts.flag === 'a' ? c.appendFrom(src(), p) : c.uploadFrom(src(), p))), cb);
  }

  readFile(p, cb) {
    this.done(this.run(async (c) => {
      const chunks = [];
      await c.downloadTo(new Writable({ write(chunk, _enc, next) { chunks.push(chunk); next(); } }), p);
      return Buffer.concat(chunks);
    }), cb);
  }

  end() { this.client.close(); }
}

// Abre la conexión: secure = 'explicit' (FTPS) o false; insecure acepta certificados no verificados
async function connectFtp({ host, port, user, password, secure, insecure }) {
  const client = new ftp.Client(25000);
  await client.access({
    host, port: port || 21, user: user || 'anonymous', password: password || (user ? '' : 'anonymous@'),
    secure: !!secure, secureOptions: secure ? { rejectUnauthorized: !insecure } : undefined,
  });
  return new FtpFs(client);
}

module.exports = { connectFtp, FtpFs };
