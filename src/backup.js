'use strict';
// Respaldo cifrado de ReaXTerm: AES-256-GCM con clave derivada por scrypt de la contraseña del usuario
const crypto = require('crypto');

const FORMAT = 'reaxterm-backup';
const KDF = { N: 32768, r: 8, p: 1 };

function deriveKey(password, salt, { N, r, p }) {
  return crypto.scryptSync(password, salt, 32, { N, r, p, maxmem: 128 * N * r * 2 });
}

function seal(payload, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(password, salt, KDF);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return {
    format: FORMAT, version: 1, app: 'ReaXTerm', created: new Date().toISOString(),
    kdf: { name: 'scrypt', ...KDF, salt: salt.toString('base64') },
    cipher: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

const isSealed = (file) => !!file && file.format === FORMAT;

function open(file, password) {
  if (!isSealed(file) || file.cipher !== 'aes-256-gcm' || !file.kdf || file.kdf.name !== 'scrypt') throw new Error('Formato de respaldo no reconocido');
  const key = deriveKey(password, Buffer.from(file.kdf.salt, 'base64'), file.kdf);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(file.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(file.tag, 'base64'));
  let text;
  try {
    text = Buffer.concat([decipher.update(Buffer.from(file.data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    const err = new Error('Contraseña incorrecta o archivo dañado');
    err.wrongPassword = true;
    throw err;
  }
  return JSON.parse(text);
}

module.exports = { seal, open, isSealed };
