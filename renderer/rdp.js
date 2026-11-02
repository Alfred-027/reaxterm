// Carga el cliente RDP en WebAssembly (IronRDP) como módulo y lo expone a app.js.
// El componente <iron-remote-desktop> dibuja el escritorio remoto en un canvas; el tráfico pasa por
// el puente RDCleanPath del proceso principal (src/rdpproxy.js).
import '../node_modules/@devolutions/iron-remote-desktop/iron-remote-desktop.js';
import { Backend, init, displayControl } from '../node_modules/@devolutions/iron-remote-desktop-rdp/iron-remote-desktop-rdp.js';

let ready = null;
window.RxRdp = {
  load() {
    // El WASM se inicializa una sola vez, la primera vez que se abre una pestaña RDP
    ready = ready || init('WARN').then(() => ({ Backend, displayControl }));
    return ready;
  },
};
window.dispatchEvent(new Event('rxrdp-loaded'));
