// Compilación local (sin firma): deja el ejecutable idéntico al electron.exe original.
// electron-builder le incrusta datos propios de cada compilación, lo que cambia su hash y hace que
// el Control inteligente de aplicaciones de Windows lo bloquee como archivo desconocido.
// En GitHub Actions (RX_SIGNED=1) el .exe conserva el ícono de ReaXTerm porque SignPath lo firma.
const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32' || process.env.RX_SIGNED === '1') return;
  const original = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe');
  const target = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  fs.copyFileSync(original, target);
};
