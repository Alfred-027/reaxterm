'use strict';
/* ReaXTerm — lógica de la interfaz */

// ============================================================ utilidades
const $ = (sel, root = document) => root.querySelector(sel);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const api = async (ch, ...args) => {
  const r = await rx.invoke(ch, ...args);
  if (r && r.ok === false) throw new Error(r.error);
  return r ? r.value : undefined;
};

const fmtSize = (n) => {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(n < 10 ? 1 : 0) + ' ' + u[i];
};
const fmtDate = (ms) => new Date(ms).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' });
const fmtDur = (ms) => {
  const s = Math.floor(ms / 1000);
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((v) => String(v).padStart(2, '0')).join(':');
};
const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// ============================================================ estado
const ACCENTS = ['#4f8cff', '#8b5cf6', '#10b981', '#f97316', '#ec4899', '#06b6d4', '#eab308', '#ef4444'];
const TAG_COLORS = ['', '#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#4f8cff', '#8b5cf6', '#ec4899'];
const TYPES = {
  ssh: { label: 'SSH', icon: 'ssh', desc: 'Terminal seguro + explorador SFTP' },
  telnet: { label: 'Telnet', icon: 'plug', desc: 'Equipos de red y servicios antiguos' },
  local: { label: 'Terminal local', icon: 'terminal', desc: 'PowerShell, CMD, WSL o Git Bash' },
  rdp: { label: 'Escritorio remoto', icon: 'monitor', desc: 'Conexión RDP a Windows' },
  sftp: { label: 'SFTP', icon: 'folder', desc: 'Sólo explorador de archivos por SSH' },
  ftp: { label: 'FTP', icon: 'hardDrive', desc: 'Explorador de archivos FTP o FTPS' },
  serial: { label: 'Serie', icon: 'cable', desc: 'Consola por puerto COM' },
};
const DEFAULT_PORTS = { ssh: 22, sftp: 22, telnet: 23, rdp: 3389, ftp: 21 };
const isFilesType = (type) => type === 'sftp' || type === 'ftp';
const BAUD_RATES = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
const FOLDER_ICONS = ['folder', 'server', 'monitor', 'globe', 'cloud', 'database', 'shield', 'lock', 'briefcase', 'home', 'cpu', 'wifi', 'terminal', 'code', 'tool', 'star', 'flag', 'activity'];
const DEFAULT_SETTINGS = {
  appTheme: 'dark', accent: '#4f8cff', fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, monospace", fontSize: 14,
  lineHeight: 1.15, termTheme: 'reax', cursorStyle: 'bar', cursorBlink: true, scrollback: 10000, copyOnSelect: true,
  rightClickPaste: false, confirmClose: true, autoSftp: true, defaultShell: 'powershell', sidebarWidth: 290,
  sidebarOpen: true, openFolders: {}, folderStyles: {}, compactSessions: true, sftpHidden: false, sftpFollow: false, webgl: true, pasteWarnLines: 5,
};
const DEFAULT_SNIPPETS = [
  ['Información del sistema', 'uname -a && cat /etc/os-release | head -n 4 && uptime'],
  ['Uso de disco', 'df -h'],
  ['Memoria', 'free -h'],
  ['Procesos con más CPU', 'ps aux --sort=-%cpu | head -n 16'],
  ['Puertos en escucha', 'sudo ss -tulpn'],
  ['Últimos logs del sistema', 'sudo journalctl -n 60 --no-pager'],
  ['Servicios con fallos', 'systemctl --failed'],
  ['Actualizaciones (Debian/Ubuntu)', 'sudo apt update && apt list --upgradable'],
].map(([name, command]) => ({ id: uid(), name, command, enter: true }));

const D = { sessions: [], credentials: [], snippets: [], tunnels: [], recent: [], settings: { ...DEFAULT_SETTINGS } };
const tabs = new Map();
let order = [];          // orden de pestañas
let activeId = null;
let layout = 'tabs';     // 'tabs' | 'grid'
let multiExec = false;
let multiGrid = false;   // mosaico abierto automáticamente por la multi-ejecución
let panel = 'sessions';
let INFO = { shells: [], ptyAvailable: true };
const tunnelState = {};  // id -> {state, text}
const sftp = new Map();  // tabId -> {cwd, entries, sel:Set, loading, error, filter}
const transfers = new Map();

const S = () => D.settings;
const persist = {};
function save(key) {
  persist[key] = persist[key] || debounce(() => api('store:set', key, D[key]).catch((e) => toast(e.message, 'error')), 250);
  persist[key]();
}

// ============================================================ avisos, modales y menús
function toast(msg, type = 'info', ms = 3800) {
  let box = $('.toasts');
  if (!box) { box = h('div', { class: 'toasts' }); document.body.append(box); }
  const ic = { ok: 'check', error: 'alert', warn: 'alert', info: 'info' }[type] || 'info';
  const t = h('div', { class: 'toast ' + type }, icon(ic, 16), h('span', {}, msg));
  box.append(t);
  setTimeout(() => t.remove(), ms);
}

function modal({ title, body, actions = [], width, onClose, iconName }) {
  const prevFocus = document.activeElement;
  const backdrop = h('div', { class: 'backdrop' });
  const close = (v) => { backdrop.remove(); document.removeEventListener('keydown', onKey, true); if (onClose) onClose(v); if (prevFocus && prevFocus.focus) prevFocus.focus(); };
  const foot = h('div', { class: 'modal-foot' });
  for (const a of actions) {
    const b = h('button', { class: 'btn ' + (a.primary ? 'primary' : '') + (a.danger ? ' danger solid' : '') + (a.left ? ' left' : '') + (a.ghost ? ' ghost' : '') }, a.icon && icon(a.icon, 15), a.label);
    b.addEventListener('click', async () => {
      if (!a.onClick) return close(a.value);
      b.disabled = true;
      try { const keep = await a.onClick(); if (keep !== false) close(a.value); } catch (e) { toast(e.message, 'error'); } finally { b.disabled = false; }
    });
    foot.append(b);
  }
  const box = h('div', { class: 'modal', style: width ? { width: width + 'px' } : null },
    h('div', { class: 'modal-head' }, iconName && icon(iconName, 18), h('h3', {}, title), h('button', { class: 'icon-btn sm', onclick: () => close(null) }, icon('x', 16))),
    h('div', { class: 'modal-body' }, body),
    actions.length ? foot : null);
  backdrop.append(box);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) backdrop.dataset.down = '1'; });
  backdrop.addEventListener('mouseup', (e) => { if (e.target === backdrop && backdrop.dataset.down) close(null); backdrop.dataset.down = ''; });
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(null); }
    if (e.key === 'Enter' && e.target.tagName === 'INPUT' && !e.target.closest('[data-noenter]')) {
      const primary = foot.querySelector('.btn.primary'); if (primary) { e.preventDefault(); primary.click(); }
    }
  };
  document.addEventListener('keydown', onKey, true);
  $('#overlays').append(backdrop);
  setTimeout(() => { const f = box.querySelector('[autofocus], .modal-body input, .modal-body textarea'); if (f) f.focus(); }, 30);
  return { close, box };
}

function promptText(title, label, value = '', { password = false, placeholder = '' } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { class: 'input', type: password ? 'password' : 'text', value, placeholder, autofocus: true });
    let result = null;
    modal({
      title, width: 440, body: h('div', { class: 'field' }, h('label', {}, label), input),
      actions: [{ label: 'Cancelar', ghost: true }, { label: 'Aceptar', primary: true, onClick: () => { result = input.value; } }],
      onClose: () => resolve(result),
    });
    setTimeout(() => input.select(), 40);
  });
}

function confirmBox(title, message, { okLabel = 'Aceptar', danger = false } = {}) {
  return new Promise((resolve) => {
    let ok = false;
    modal({
      title, width: 440, body: h('p', {}, message),
      actions: [{ label: 'Cancelar', ghost: true }, { label: okLabel, primary: !danger, danger, onClick: () => { ok = true; } }],
      onClose: () => resolve(ok),
    });
  });
}

function showMenu(x, y, items) {
  closeMenu();
  const m = h('div', { class: 'menu', id: 'ctxmenu' });
  for (const it of items) {
    if (!it) continue;
    if (it.sep) { m.append(h('div', { class: 'menu-sep' })); continue; }
    m.append(h('div', {
      class: 'menu-item' + (it.danger ? ' danger' : '') + (it.disabled ? ' disabled' : ''),
      onclick: () => { closeMenu(); it.action(); },
    }, icon(it.icon || 'chevron', 15), it.label, it.hint && h('span', { class: 'hint' }, it.hint)));
  }
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  setTimeout(() => document.addEventListener('mousedown', menuAway, true), 0);
}
function menuAway(e) { if (!e.target.closest('#ctxmenu')) closeMenu(); }
function closeMenu() { const m = $('#ctxmenu'); if (m) m.remove(); document.removeEventListener('mousedown', menuAway, true); }

// Diálogos solicitados por el proceso principal (contraseñas, claves de host)
rx.on('ui:prompt', (id, o) => {
  if (o.kind === 'hostkey') {
    let answer = null;
    const body = h('div', {},
      h('p', {}, o.changed
        ? '⚠ La clave del servidor ha CAMBIADO desde la última conexión. Podría tratarse de una reinstalación o de un ataque de intermediario.'
        : 'Es la primera vez que te conectas a este servidor. Verifica la huella antes de continuar.'),
      h('div', { class: 'field' }, h('label', {}, 'Servidor'), h('div', { class: 'fp' }, o.host)),
      o.changed && h('div', { class: 'field' }, h('label', {}, 'Huella anterior'), h('div', { class: 'fp' }, o.previous)),
      h('div', { class: 'field' }, h('label', {}, 'Huella SHA256'), h('div', { class: 'fp' }, o.fingerprint)));
    modal({
      title: o.changed ? 'Clave de host modificada' : 'Nuevo servidor', iconName: 'shield', width: 520, body,
      actions: [
        { label: 'Cancelar', ghost: true, value: null },
        { label: 'Sólo esta vez', onClick: () => { answer = 'once'; } },
        { label: 'Aceptar y recordar', primary: !o.changed, danger: o.changed, onClick: () => { answer = 'save'; } },
      ],
      onClose: () => rx.reply(id, answer),
    });
    return;
  }
  promptText(o.title || 'ReaXTerm', o.message || '', '', { password: o.kind === 'password' }).then((v) => rx.reply(id, v));
});
rx.on('app:toast', (msg, type) => toast(msg, type));

// ============================================================ tema
function applyTheme() {
  const s = S();
  let theme = s.appTheme;
  if (theme === 'system') theme = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.setProperty('--accent', s.accent);
  const cs = getComputedStyle(document.documentElement);
  api('app:titlebar', cs.getPropertyValue('--bg').trim(), cs.getPropertyValue('--text-2').trim()).catch(() => {});
  for (const t of tabs.values()) applyTermOptions(t);
}

function termTheme() { return (TERM_THEMES[S().termTheme] || TERM_THEMES.reax).colors; }

function applyTermOptions(t) {
  const s = S();
  Object.assign(t.term.options, {
    fontFamily: s.fontFamily, fontSize: s.fontSize, lineHeight: s.lineHeight, cursorStyle: s.cursorStyle,
    cursorBlink: s.cursorBlink, scrollback: s.scrollback, theme: termTheme(),
  });
  t.el.querySelector('.pane-term').style.background = termTheme().background;
  fitTab(t);
}

// ============================================================ terminales
function sessionTitle(s) {
  if (s.name) return s.name;
  if (s.type === 'local') return (INFO.shells.find((x) => x.id === s.shell) || { label: 'Terminal' }).label;
  if (s.type === 'serial') return s.serialPort || 'Puerto serie';
  return (s.user ? s.user + '@' : '') + s.host;
}

function openSession(s) {
  if (s.type === 'rdp') return launchRdp(s);
  if (s.id) {
    D.recent = [s.id, ...D.recent.filter((r) => r !== s.id)].slice(0, 8);
    save('recent');
  }
  const id = uid();
  const termEl = h('div', { class: 'pane-term' });
  const searchInput = h('input', { placeholder: 'Buscar en la terminal…', spellcheck: 'false' });
  const searchBox = h('div', { class: 'term-search' }, icon('search', 14), searchInput,
    h('button', { class: 'icon-btn sm', title: 'Anterior (Shift+Enter)', onclick: () => t.search.findPrevious(searchInput.value) }, icon('arrowUp', 14)),
    h('button', { class: 'icon-btn sm', title: 'Siguiente (Enter)', onclick: () => t.search.findNext(searchInput.value) }, icon('chevronDown', 14)),
    h('button', { class: 'icon-btn sm', onclick: () => closeSearch(t) }, icon('x', 14)));
  const pane = h('div', { class: 'pane', dataset: { id } },
    h('div', { class: 'pane-head' }, h('span', { class: 'dot' }), icon(TYPES[s.type].icon, 13), h('span', { class: 'title' }, sessionTitle(s)),
      h('button', { class: 'icon-btn sm', title: 'Cerrar', onclick: (e) => { e.stopPropagation(); closeTab(id); } }, icon('x', 13))),
    termEl, searchBox,
    isFilesType(s.type) && h('div', { class: 'pane-files' }),
    h('div', { class: 'drop-hint' }, icon('upload', 22), 'Suelta para subir al directorio SFTP actual'));
  if (isFilesType(s.type)) pane.classList.add('files');
  $('#terms').append(pane);

  const term = new Terminal({
    allowProposedApi: true, macOptionIsMeta: true, convertEol: false, smoothScrollDuration: 0,
    fontFamily: S().fontFamily, fontSize: S().fontSize, lineHeight: S().lineHeight, cursorStyle: S().cursorStyle,
    cursorBlink: S().cursorBlink, scrollback: S().scrollback, theme: termTheme(),
  });
  const fit = new FitAddon.FitAddon();
  const search = new SearchAddon.SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(new WebLinksAddon.WebLinksAddon((_e, uri) => window.open(uri)));
  const u11 = new Unicode11Addon.Unicode11Addon();
  term.loadAddon(u11);
  term.unicode.activeVersion = '11';

  const t = {
    id, session: { ...s }, term, fit, search, el: pane, state: 'connecting', statusText: 'Conectando…',
    startedAt: null, title: sessionTitle(s), logging: null, multi: !isFilesType(s.type), opened: false,
  };
  // El shell remoto informa su directorio con OSC 7337 (ReaXTerm) u OSC 7 (estándar): es invisible
  const onCwd = (dir) => {
    if (!dir) return;
    t.cwd = dir;
    const st = sftp.get(id);
    if (S().sftpFollow && st && st.cwd !== dir && !st.loading) sftpLoad(id, dir);
  };
  term.parser.registerOscHandler(7337, (data) => { onCwd(data.trim()); return true; });
  term.parser.registerOscHandler(7, (data) => {
    try { onCwd(decodeURIComponent(new URL(data).pathname)); } catch { /* no es una URL file:// */ }
    return true;
  });
  tabs.set(id, t);
  order.push(id);
  termEl.style.background = termTheme().background;

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? search.findPrevious(searchInput.value) : search.findNext(searchInput.value); }
    if (e.key === 'Escape') { e.preventDefault(); closeSearch(t); }
  });
  searchInput.addEventListener('input', () => search.findNext(searchInput.value, { incremental: true }));

  pane.addEventListener('mousedown', () => { if (activeId !== id) activate(id); });
  bindTerminalInput(t);
  bindDrop(t, pane);
  new ResizeObserver(debounce(() => fitTab(t), 40)).observe(termEl);

  activate(id);
  requestAnimationFrame(() => {
    term.open(termEl);
    if (S().webgl) { try { const gl = new WebglAddon.WebglAddon(); gl.onContextLoss(() => gl.dispose()); term.loadAddon(gl); } catch { /* sin WebGL */ } }
    t.opened = true;
    fitTab(t);
    term.focus();
    connectTab(t);
  });
  renderAll();
  return t;
}

function bindTerminalInput(t) {
  const { term } = t;
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyC') { copySelection(t); return false; }
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyV') { pasteInto(t); return false; }
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'KeyV') { pasteInto(t); e.preventDefault(); return false; }
    if (e.ctrlKey && !e.shiftKey && e.code === 'KeyC' && term.hasSelection()) { copySelection(t); term.clearSelection(); return false; }
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyF') { openSearch(t); return false; }
    if (isGlobalShortcut(e)) return false;
    return true;
  });
  term.onData((d) => {
    if (t.state === 'closed') {
      if (/^[rR]$/.test(d)) reconnect(t);
      else if (d === '\r') closeTab(t.id, { force: true });
      return;
    }
    if (t.state !== 'connected') return;
    if (multiExec && t.multi) { for (const o of tabs.values()) if (o.state === 'connected' && o.multi) rx.write(o.id, d); }
    else rx.write(t.id, d);
  });
  term.onBinary((d) => rx.write(t.id, d));
  term.onResize(({ cols, rows }) => rx.resize(t.id, cols, rows));
  term.onSelectionChange(() => { if (S().copyOnSelect && term.hasSelection()) api('clip:write', term.getSelection()); });
  term.onTitleChange((title) => { if (title && !t.renamed) { t.remoteTitle = title; renderTabs(); } });
  term.onBell(() => { if (activeId !== t.id) { t.bell = true; renderTabs(); } });
  t.el.querySelector('.pane-term').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (S().rightClickPaste && !e.ctrlKey) { if (term.hasSelection()) { copySelection(t); term.clearSelection(); } else pasteInto(t); return; }
    showMenu(e.clientX, e.clientY, terminalMenuItems(t));
  });
}

function terminalMenuItems(t) {
  return [
    { label: 'Copiar', icon: 'copy', hint: 'Ctrl+Shift+C', disabled: !t.term.hasSelection(), action: () => copySelection(t) },
    { label: 'Pegar', icon: 'download', hint: 'Ctrl+V', action: () => pasteInto(t) },
    { label: 'Seleccionar todo', icon: 'maximize', action: () => t.term.selectAll() },
    { label: 'Buscar…', icon: 'search', hint: 'Ctrl+Shift+F', action: () => openSearch(t) },
    { sep: true },
    { label: 'Limpiar pantalla', icon: 'refresh', action: () => t.term.clear() },
    { label: t.logging ? 'Detener registro de sesión' : 'Registrar sesión en archivo…', icon: 'record', action: () => toggleLog(t) },
    { label: 'Exportar contenido del búfer…', icon: 'export', action: () => exportBuffer(t) },
    { sep: true },
    { label: t.multi ? 'Excluir de multi-ejecución' : 'Incluir en multi-ejecución', icon: 'broadcast', action: () => { t.multi = !t.multi; renderAll(); } },
    { label: 'Duplicar pestaña', icon: 'copy', action: () => openSession(t.session) },
    { label: 'Reconectar', icon: 'refresh', action: () => reconnect(t) },
    { label: 'Cerrar pestaña', icon: 'x', danger: true, hint: 'Ctrl+Shift+W', action: () => closeTab(t.id) },
  ];
}

async function copySelection(t) {
  const sel = t.term.getSelection();
  if (sel) { await api('clip:write', sel); toast('Copiado al portapapeles', 'ok', 1400); }
}

async function pasteInto(t) {
  const text = await api('clip:read');
  if (!text) return;
  const lines = text.split(/\r?\n/).length;
  if (S().pasteWarnLines && lines > S().pasteWarnLines) {
    const ok = await confirmBox('Pegar varias líneas', `Vas a pegar ${lines} líneas en «${t.title}»${multiExec ? ' y en las demás pestañas (multi-ejecución activa)' : ''}. Cada línea podría ejecutarse como comando.`, { okLabel: 'Pegar' });
    if (!ok) return;
  }
  t.term.paste(text);
  t.term.focus();
}

function openSearch(t) { const box = t.el.querySelector('.term-search'); box.classList.add('open'); const i = box.querySelector('input'); i.focus(); i.select(); }
function closeSearch(t) { t.el.querySelector('.term-search').classList.remove('open'); t.search.clearDecorations(); t.term.focus(); }

function fitTab(t) {
  if (!t.opened) return;
  const el = t.el.querySelector('.pane-term');
  if (!el.offsetWidth || !el.offsetHeight) return;
  try { t.fit.fit(); } catch { /* aún sin dimensiones */ }
}

async function connectTab(t) {
  t.state = 'connecting';
  t.statusText = 'Conectando…';
  renderAll();
  const ss = t.session;
  if (ss.type === 'serial') t.term.write(`\x1b[2m→ Abriendo ${ss.serialPort} a ${ss.baud || 9600} baudios…\x1b[0m\r\n`);
  else if (ss.type !== 'local') t.term.write(`\x1b[2m→ Conectando a ${ss.host}:${ss.port || DEFAULT_PORTS[ss.type]}…\x1b[0m\r\n`);
  try {
    await api('term:open', t.id, t.session, { cols: t.term.cols, rows: t.term.rows });
    if (!tabs.has(t.id)) return;
    // el estado definitivo llega por «term:status»
  } catch (e) {
    if (!tabs.has(t.id)) return;
    t.state = 'closed';
    t.statusText = e.message;
    t.term.write(`\r\n\x1b[31m✖ ${e.message}\x1b[0m\r\n\x1b[33mPulsa R para reintentar o Enter para cerrar la pestaña.\x1b[0m\r\n`);
    renderAll();
  }
}

async function reconnect(t) {
  await api('term:close', t.id).catch(() => {});
  t.term.write('\r\n');
  connectTab(t);
}

rx.on('term:data', (id, d) => {
  const t = tabs.get(id);
  if (!t) return;
  const chunk = typeof d === 'string' ? d : new Uint8Array(d);
  t.lastData = Date.now();
  if (t.swallow) swallowData(t, chunk); else t.term.write(chunk);
});

// ------------------------------------------------------------ seguir a la terminal (silencioso)
// Se instala una sola vez por conexión un gancho de prompt que emite el directorio actual como
// secuencia OSC invisible. El eco de la instalación se descarta hasta ver la marca OSC 7338.
const FOLLOW_MARK = '\x1b]7338;\x07';
const FOLLOW_HOOK = ` __rx_cwd(){ printf '\\033]7337;%s\\007' "$PWD"; }; if [ -n "$ZSH_VERSION" ]; then precmd_functions+=(__rx_cwd); else PROMPT_COMMAND="__rx_cwd\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"; fi; printf '\\033]7338;\\007'`;

function swallowData(t, chunk) {
  const sw = t.swallow;
  sw.raw.push(chunk);
  sw.text += typeof chunk === 'string' ? chunk : sw.dec.decode(chunk, { stream: true });
  const i = sw.text.indexOf(FOLLOW_MARK);
  if (i < 0) return;
  clearTimeout(sw.timer);
  t.swallow = null;
  t.followHooked = true;
  // Se borra la línea del prompt anterior: el nuevo prompt se dibuja en su lugar
  t.term.write('\r\x1b[2K' + sw.text.slice(i + FOLLOW_MARK.length).replace(/^\r?\n/, ''));
}

function hookFollow(t, tries = 0) {
  if (!tabs.has(t.id) || t.session.type !== 'ssh' || t.state !== 'connected' || t.followHooked || t.swallow) return;
  // Espera a que el shell esté inactivo (sin salida reciente) para no mezclarse con el MOTD o un comando
  const quiet = Date.now() - (t.lastData || 0) > 700 && Date.now() - (t.startedAt || 0) > 1200;
  if (!quiet) { if (tries < 40) setTimeout(() => hookFollow(t, tries + 1), 400); return; }
  t.swallow = { raw: [], text: '', dec: new TextDecoder() };
  // Si el shell no es bash/zsh (p. ej. un equipo de red) se muestra lo recibido tal cual
  t.swallow.timer = setTimeout(() => {
    const sw = t.swallow;
    if (!sw) return;
    t.swallow = null;
    t.followHooked = true;
    for (const c of sw.raw) t.term.write(c);
  }, 3000);
  rx.write(t.id, '\x05\x15' + FOLLOW_HOOK + '\r');
}

function toggleFollow(id) {
  S().sftpFollow = !S().sftpFollow;
  save('settings');
  const t = tabs.get(id);
  if (S().sftpFollow && t) {
    if (t.cwd) sftpLoad(id, t.cwd);
    hookFollow(t);
  }
  toast(S().sftpFollow ? 'El explorador sigue al directorio de la terminal' : 'Seguimiento de la terminal desactivado', 'info', 2200);
  renderSide();
}
rx.on('term:status', (id, state, text) => {
  const t = tabs.get(id);
  if (!t) return;
  t.state = state;
  t.statusText = text;
  if (state === 'connected') {
    t.startedAt = Date.now();
    t.followHooked = false;
    if (t.session.type === 'ssh') {
      sftp.delete(id);
      if (S().autoSftp && activeId === id) setPanel('sftp');
      if (S().sftpFollow) hookFollow(t);
    }
    if (isFilesType(t.session.type)) { sftp.delete(id); sftpLoad(id, '.'); }
    rx.resize(id, t.term.cols, t.term.rows);
  }
  renderAll();
});
rx.on('term:exit', (id, reason) => {
  const t = tabs.get(id);
  if (!t) return;
  t.state = 'closed';
  t.statusText = reason;
  t.logging = null;
  t.followHooked = false;
  t.term.write(`\r\n\x1b[33m● ${reason}. Pulsa R para reconectar o Enter para cerrar la pestaña.\x1b[0m\r\n`);
  sftp.delete(id);
  renderAll();
});

async function closeTab(id, { force = false } = {}) {
  const t = tabs.get(id);
  if (!t) return;
  if (!force && S().confirmClose && t.state === 'connected' && t.session.type !== 'local') {
    const ok = await confirmBox('Cerrar sesión', `¿Cerrar la conexión «${t.title}»?`, { okLabel: 'Cerrar', danger: true });
    if (!ok) return;
  }
  api('term:close', id).catch(() => {});
  t.term.dispose();
  t.el.remove();
  tabs.delete(id);
  sftp.delete(id);
  const idx = order.indexOf(id);
  order = order.filter((x) => x !== id);
  if (activeId === id) activeId = order[Math.min(idx, order.length - 1)] || null;
  if (activeId) activate(activeId); else renderAll();
}

function activate(id) {
  activeId = id;
  const t = tabs.get(id);
  if (t) { t.bell = false; }
  renderAll();
  if (t) requestAnimationFrame(() => { if (!t.opened || isFilesType(t.session.type)) return; fitTab(t); if (!document.activeElement || !document.activeElement.closest('.modal, .side, .quick')) t.term.focus(); });
}

function cycleTab(dir) {
  if (!order.length) return;
  const i = order.indexOf(activeId);
  activate(order[(i + dir + order.length) % order.length]);
}

async function toggleLog(t) {
  try {
    if (t.logging) { await api('term:log', t.id, false); t.logging = null; toast('Registro detenido', 'info'); }
    else { const file = await api('term:log', t.id, true, t.title); if (file) { t.logging = file; toast('Registrando en ' + file, 'ok'); } }
    renderAll();
  } catch (e) { toast(e.message, 'error'); }
}

function exportBuffer(t) {
  const buf = t.term.buffer.active;
  const lines = [];
  for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i).translateToString(true));
  const blob = new Blob([lines.join('\r\n').replace(/\s+$/, '') + '\r\n'], { type: 'text/plain' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `${t.title.replace(/[^\w.-]+/g, '_')}.txt` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function newLocal(shell) {
  openSession({ type: 'local', shell: shell || S().defaultShell, name: '' });
}

async function launchRdp(s) {
  try { await api('launch:rdp', s); toast(`Abriendo escritorio remoto: ${s.host}`, 'ok'); } catch (e) { toast(e.message, 'error'); }
}

// Arrastrar archivos del explorador a la terminal => subida SFTP
function bindDrop(t, pane) {
  let depth = 0;
  pane.addEventListener('dragenter', (e) => { if (t.session.type === 'ssh' && e.dataTransfer.types.includes('Files')) { depth++; pane.classList.add('dragging'); } });
  pane.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; pane.classList.remove('dragging'); } });
  pane.addEventListener('dragover', (e) => e.preventDefault());
  pane.addEventListener('drop', async (e) => {
    e.preventDefault();
    depth = 0;
    pane.classList.remove('dragging');
    if (t.session.type !== 'ssh' || t.state !== 'connected') return;
    const files = [...e.dataTransfer.files].map((f) => rx.pathForFile(f)).filter(Boolean);
    if (!files.length) return;
    const st = await ensureSftp(t.id);
    if (st) uploadFiles(t.id, st.cwd, files);
  });
}

// ============================================================ multi-ejecución y disposición
function toggleMulti() {
  multiExec = !multiExec;
  // Mientras dura la multi-ejecución se muestran todas las terminales a la vez
  if (multiExec && layout === 'tabs' && order.length > 1) { layout = 'grid'; multiGrid = true; }
  else if (!multiExec && multiGrid) { layout = 'tabs'; multiGrid = false; }
  toast(multiExec ? 'Multi-ejecución activada: lo que escribas se envía a todas las pestañas conectadas' : 'Multi-ejecución desactivada', multiExec ? 'warn' : 'info');
  renderAll();
  setTimeout(() => { for (const t of tabs.values()) fitTab(t); }, 30);
}

function toggleLayout() {
  multiGrid = false;
  layout = layout === 'tabs' ? 'grid' : 'tabs';
  renderAll();
  setTimeout(() => { for (const t of tabs.values()) fitTab(t); }, 30);
}

// ============================================================ render general
function renderAll() {
  renderTitleActions();
  renderTabs();
  renderPanes();
  renderWelcome();
  renderStatus();
  renderRail();
  renderSide();
}

function renderTitleActions() {
  const box = $('#titleActions');
  box.replaceChildren(
    h('button', { class: 'icon-btn tip-down', 'data-tip': 'Nueva sesión (Ctrl+Shift+N)', onclick: () => editSession() }, icon('plus', 17)),
    h('button', { class: 'icon-btn tip-down', 'data-tip': 'Terminal local', onclick: (e) => shellMenu(e) }, icon('terminal', 17)),
    h('button', { class: 'icon-btn tip-down' + (multiExec ? ' warn-on' : ''), 'data-tip': 'Multi-ejecución (Ctrl+Shift+M)', onclick: toggleMulti }, icon('broadcast', 17)),
    h('button', { class: 'icon-btn tip-down' + (layout === 'grid' ? ' on' : ''), 'data-tip': 'Vista en mosaico (Ctrl+Shift+L)', onclick: toggleLayout }, icon(layout === 'grid' ? 'tabs' : 'grid', 17)),
    h('button', { class: 'icon-btn tip-down', 'data-tip': 'Ajustes', onclick: () => openSettings() }, icon('settings', 17)),
  );
}

function shellMenu(e) {
  const r = e.currentTarget.getBoundingClientRect();
  showMenu(r.left, r.bottom + 6, INFO.shells.map((s) => ({ label: s.label, icon: 'terminal', hint: s.id === S().defaultShell ? 'predeterminado' : '', action: () => newLocal(s.id) })));
}

function tabTitle(t) { return t.renamed || t.title; }

function renderTabs() {
  const box = $('#tabs');
  box.replaceChildren(...order.map((id) => {
    const t = tabs.get(id);
    const color = t.session.color;
    const el = h('div', {
      class: 'tab' + (id === activeId ? ' active' : ''), draggable: 'true', title: `${tabTitle(t)}\n${t.statusText || ''}`,
      onclick: () => activate(id),
      onauxclick: (e) => { if (e.button === 1) closeTab(id); },
      ondblclick: async () => { const n = await promptText('Renombrar pestaña', 'Nombre', tabTitle(t)); if (n) { t.renamed = n; renderAll(); } },
      oncontextmenu: (e) => { e.preventDefault(); showMenu(e.clientX, e.clientY, terminalMenuItems(t)); },
    },
    color && h('span', { class: 'colorbar', style: { background: color } }),
    h('span', { class: 'dot ' + t.state }),
    icon(TYPES[t.session.type].icon, 14),
    h('span', { class: 'title' }, (t.bell ? '🔔 ' : '') + tabTitle(t)),
    multiExec && t.multi && t.state === 'connected' ? h('span', { style: { color: 'var(--warn)' } }, icon('broadcast', 12)) : null,
    t.logging ? h('span', { style: { color: 'var(--err)' }, title: 'Registrando' }, icon('record', 12)) : null,
    h('button', { class: 'icon-btn sm close', onclick: (e) => { e.stopPropagation(); closeTab(id); } }, icon('x', 13)));
    el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/x-tab', id); });
    el.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/x-tab')) { e.preventDefault(); el.classList.add('dragover'); } });
    el.addEventListener('dragleave', () => el.classList.remove('dragover'));
    el.addEventListener('drop', (e) => {
      const src = e.dataTransfer.getData('text/x-tab');
      el.classList.remove('dragover');
      if (!src || src === id) return;
      order = order.filter((x) => x !== src);
      order.splice(order.indexOf(id), 0, src);
      renderAll();
    });
    return el;
  }));
  const act = box.querySelector('.tab.active');
  if (act) act.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function renderPanes() {
  const terms = $('#terms');
  terms.classList.toggle('grid', layout === 'grid' && order.length > 1);
  if (layout === 'grid' && order.length > 1) {
    const cols = Math.ceil(Math.sqrt(order.length));
    terms.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    terms.style.gridTemplateRows = `repeat(${Math.ceil(order.length / cols)}, minmax(0, 1fr))`;
  } else { terms.style.gridTemplateColumns = ''; terms.style.gridTemplateRows = ''; }
  // Reordenar sólo si cambió: mover un nodo del DOM le quita el foco a la terminal
  const current = [...terms.children].map((el) => el.dataset.id);
  if (current.join() !== order.join()) for (const id of order) terms.append(tabs.get(id).el);
  for (const id of order) {
    const t = tabs.get(id);
    t.el.classList.toggle('visible', layout === 'grid' || id === activeId);
    t.el.classList.toggle('active', id === activeId);
    t.el.classList.toggle('multi', multiExec && t.multi && t.state === 'connected');
    if (isFilesType(t.session.type)) renderFilesPane(t);
    t.el.querySelector('.pane-head .dot').className = 'dot ' + t.state;
    t.el.querySelector('.pane-head .title').textContent = tabTitle(t);
  }
}

function renderStatus() {
  const t = tabs.get(activeId);
  const runningTunnels = Object.values(tunnelState).filter((x) => x.state === 'running').length;
  const items = [];
  if (t) {
    items.push(h('span', { class: 'item' }, h('span', { class: 'dot ' + t.state }), t.statusText || ''));
    if (t.startedAt && t.state === 'connected') items.push(h('span', { class: 'item', id: 'uptime' }, icon('clock', 12), fmtDur(Date.now() - t.startedAt)));
    items.push(h('span', { class: 'item' }, `${t.term.cols}×${t.term.rows}`));
    if (t.logging) items.push(h('span', { class: 'item', style: { color: 'var(--err)' } }, icon('record', 12), 'Registrando'));
  } else items.push(h('span', { class: 'item' }, 'Listo'));
  items.push(h('span', { class: 'spacer' }));
  if (multiExec) items.push(h('span', { class: 'pill warn clickable', onclick: toggleMulti }, 'MULTI-EJECUCIÓN'));
  if (runningTunnels) items.push(h('span', { class: 'pill ok clickable', onclick: () => setPanel('tunnels') }, `${runningTunnels} túnel${runningTunnels > 1 ? 'es' : ''}`));
  items.push(h('span', { class: 'item' }, `${tabs.size} pestaña${tabs.size === 1 ? '' : 's'}`));
  items.push(h('span', { class: 'item clickable', onclick: openPalette }, icon('command', 12), 'Ctrl+Shift+P'));
  $('#statusbar').replaceChildren(...items);
}
setInterval(() => {
  const t = tabs.get(activeId);
  const el = $('#uptime');
  if (t && el && t.startedAt) el.lastChild.textContent = fmtDur(Date.now() - t.startedAt);
}, 1000);

// ============================================================ pantalla de bienvenida
function renderWelcome() {
  const w = $('#welcome');
  w.classList.toggle('show', tabs.size === 0);
  if (tabs.size) return;
  const card = (ic, title, desc, fn) => h('div', { class: 'card', onclick: fn }, h('div', { class: 'card-ic' }, icon(ic, 20)), h('h3', {}, title), h('p', {}, desc));
  const recent = D.recent.map((id) => D.sessions.find((s) => s.id === id)).filter(Boolean);
  const shortcuts = [
    ['Paleta de comandos', 'Ctrl+Shift+P'], ['Nueva sesión', 'Ctrl+Shift+N'], ['Terminal local', 'Ctrl+Shift+T'],
    ['Cerrar pestaña', 'Ctrl+Shift+W'], ['Cambiar de pestaña', 'Ctrl+Tab'], ['Ir a pestaña 1-9', 'Alt+1…9'],
    ['Multi-ejecución', 'Ctrl+Shift+M'], ['Vista mosaico', 'Ctrl+Shift+L'], ['Buscar en terminal', 'Ctrl+Shift+F'],
    ['Mostrar/ocultar panel', 'Ctrl+Shift+B'], ['Zoom de fuente', 'Ctrl + / Ctrl −'], ['Pantalla completa', 'F11'],
  ];
  w.replaceChildren(h('div', { class: 'welcome-inner' },
    h('div', { class: 'hero' }, h('img', { src: '../assets/logo.svg', alt: '' }),
      h('div', {}, h('h1', {}, 'Bienvenido a Rea', h('b', {}, 'X'), 'Term'), h('p', {}, 'Tu centro de control para servidores: SSH, SFTP, FTP, Telnet, RDP, puerto serie, túneles y terminales locales en un solo lugar.'))),
    h('div', { class: 'cards' },
      card('server', 'Nueva sesión SSH', 'Guarda servidor, usuario y clave', () => editSession({ type: 'ssh' })),
      card('terminal', 'Terminal local', (INFO.shells.find((s) => s.id === S().defaultShell) || { label: 'PowerShell' }).label, () => newLocal()),
      card('monitor', 'Escritorio remoto', 'Abre una conexión RDP', () => editSession({ type: 'rdp' })),
      card('import', 'Importar sesiones', 'MobaXterm, PuTTY, mRemoteNG, Excel, CSV, JSON…', openImport),
      card('tunnel', 'Túneles SSH', 'Reenvío local, remoto y SOCKS5', () => setPanel('tunnels')),
      card('tool', 'Herramientas de red', 'Ping, puertos, DNS, claves SSH', () => setPanel('tools'))),
    h('div', { class: 'cols' },
      h('div', {}, h('div', { class: 'section-title' }, 'Recientes'),
        h('div', { class: 'panel' }, recent.length ? recent.map((s) => sessionRow(s, false))
          : h('div', { class: 'empty' }, icon('clock', 26), 'Aún no hay sesiones recientes. Usa la barra de conexión rápida de arriba.'))),
      h('div', {}, h('div', { class: 'section-title' }, 'Atajos de teclado'),
        h('div', { class: 'panel shortcuts' }, shortcuts.flatMap(([a, k]) => [h('span', {}, a), h('kbd', {}, k)]))))));
}

// ============================================================ barra lateral
const PANELS = [
  { id: 'sessions', icon: 'server', label: 'Sesiones' },
  { id: 'credentials', icon: 'key', label: 'Credenciales' },
  { id: 'sftp', icon: 'folder', label: 'Explorador SFTP' },
  { id: 'tunnels', icon: 'tunnel', label: 'Túneles SSH' },
  { id: 'snippets', icon: 'code', label: 'Comandos guardados' },
  { id: 'tools', icon: 'tool', label: 'Herramientas' },
];

function setPanel(p) {
  if (panel === p && S().sidebarOpen) { renderAll(); return; }
  panel = p;
  S().sidebarOpen = true;
  save('settings');
  renderAll();
  for (const t of tabs.values()) setTimeout(() => fitTab(t), 20);
}

function toggleSidebar() {
  S().sidebarOpen = !S().sidebarOpen;
  save('settings');
  renderAll();
  setTimeout(() => { for (const t of tabs.values()) fitTab(t); }, 20);
}

function renderRail() {
  const runningTunnels = Object.values(tunnelState).filter((x) => x.state === 'running').length;
  $('#rail').replaceChildren(
    ...PANELS.map((p) => h('button', {
      class: 'rail-btn' + (panel === p.id && S().sidebarOpen ? ' active' : ''), 'data-tip': p.label,
      onclick: () => (panel === p.id && S().sidebarOpen ? toggleSidebar() : setPanel(p.id)),
    }, icon(p.icon, 20), p.id === 'tunnels' && runningTunnels ? h('span', { class: 'badge' }, runningTunnels) : null)),
    h('div', { class: 'spacer' }),
    h('button', { class: 'rail-btn', 'data-tip': 'Paleta de comandos', onclick: openPalette }, icon('command', 19)),
    h('button', { class: 'rail-btn', 'data-tip': 'Ajustes', onclick: () => openSettings() }, icon('settings', 19)),
  );
}

let sideScroll = {};
function renderSide() {
  hideHoverTip();
  const side = $('#side');
  side.classList.toggle('hidden', !S().sidebarOpen);
  side.style.width = S().sidebarWidth + 'px';
  if (!S().sidebarOpen) return;
  const inner = $('#sideInner');
  const oldBody = inner.querySelector('.side-body, .sftp-list');
  if (oldBody) sideScroll[inner.dataset.panel] = oldBody.scrollTop;
  const focused = document.activeElement;
  const focusKey = focused && inner.contains(focused) ? focused.dataset.key : null;
  const selStart = focusKey ? focused.selectionStart : null;
  const content = { sessions: sessionsPanel, credentials: credentialsPanel, sftp: sftpPanel, tunnels: tunnelsPanel, snippets: snippetsPanel, tools: toolsPanel }[panel]();
  // Herramientas mantiene su propio estado: no se reconstruye en cada render
  if (panel === 'tools' && inner.dataset.panel === 'tools') return;
  inner.dataset.panel = panel;
  inner.replaceChildren(...[].concat(content));
  const body = inner.querySelector('.side-body, .sftp-list');
  if (body && sideScroll[panel]) body.scrollTop = sideScroll[panel];
  if (focusKey) { const el = inner.querySelector(`[data-key="${focusKey}"]`); if (el) { el.focus(); try { el.setSelectionRange(selStart, selStart); } catch { /* ignore */ } } }
}

function sideHead(title, ...buttons) { return h('div', { class: 'side-head' }, h('h2', {}, title), ...buttons); }

// Redimensionar la barra lateral
(() => {
  const handle = $('#sideResizer');
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    handle.classList.add('drag');
    const startX = e.clientX, startW = $('#side').offsetWidth;
    const move = (ev) => { S().sidebarWidth = Math.max(220, Math.min(560, startW + ev.clientX - startX)); $('#side').style.width = S().sidebarWidth + 'px'; };
    const up = () => {
      handle.classList.remove('drag');
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      save('settings');
      for (const t of tabs.values()) fitTab(t);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
})();

// ------------------------------------------------------------ panel: sesiones
let sessionFilter = '';
const credOf = (s) => (s.credentialId ? D.credentials.find((c) => c.id === s.credentialId) : null);
const userOf = (s) => { const c = credOf(s); return c ? c.user || `[${c.name}]` : s.user; };
const CRED_TYPES = ['ssh', 'sftp', 'ftp', 'rdp'];
const DRAG_SESSION = 'text/x-reax-session';
const DRAG_FOLDER = 'text/x-reax-folder';
const folderStyle = (p) => S().folderStyles[p] || {};
const inFolder = (s, p) => s.folder === p || String(s.folder || '').startsWith(p + '/');

// Mueve (o renombra) una carpeta con sus subcarpetas, conservando estilo y estado abierto
function moveFolder(from, to) {
  if (from === to || to.startsWith(from + '/')) return false;
  const remap = (p) => (p === from ? to : p.startsWith(from + '/') ? to + p.slice(from.length) : p);
  for (const s of D.sessions) if (inFolder(s, from)) s.folder = remap(s.folder);
  for (const key of ['folderStyles', 'openFolders']) {
    const obj = S()[key];
    for (const k of Object.keys(obj)) if (k === from || k.startsWith(from + '/')) { obj[remap(k)] = obj[k]; delete obj[k]; }
  }
  save('sessions'); save('settings');
  return true;
}

// Soltar una sesión o carpeta arrastrada en la carpeta «target» ('' = raíz)
function dropInto(e, target) {
  const sid = e.dataTransfer.getData(DRAG_SESSION);
  const fpath = e.dataTransfer.getData(DRAG_FOLDER);
  if (sid) {
    const ids = sid.split(',');
    const list = D.sessions.filter((x) => ids.includes(x.id) && (x.folder || '') !== target);
    if (!list.length) return;
    list.forEach((s) => { s.folder = target; });
    if (target) S().openFolders[target] = true;
    save('sessions'); save('settings');
    const what = list.length === 1 ? `«${list[0].name || list[0].host || sessionTitle(list[0])}» movida` : `${list.length} sesiones movidas`;
    toast(`${what} a ${target || 'la raíz'}`, 'ok', 1800);
  } else if (fpath) {
    const name = fpath.split('/').pop();
    const to = target ? `${target}/${name}` : name;
    if (to === fpath || target === fpath || target.startsWith(fpath + '/')) return;
    if (D.sessions.some((x) => inFolder(x, to))) return toast(`Ya existe la carpeta «${to}»`, 'warn');
    moveFolder(fpath, to);
    toast(`Carpeta movida a ${target || 'la raíz'}`, 'ok', 1800);
  } else return;
  renderSide();
}

function dropTarget(el, target) {
  const accepts = (e) => e.dataTransfer.types.includes(DRAG_SESSION) || e.dataTransfer.types.includes(DRAG_FOLDER);
  el.addEventListener('dragover', (e) => { if (!accepts(e)) return; e.preventDefault(); e.stopPropagation(); el.classList.add('drop-on'); });
  el.addEventListener('dragleave', () => el.classList.remove('drop-on'));
  el.addEventListener('drop', (e) => { if (!accepts(e)) return; e.preventDefault(); e.stopPropagation(); el.classList.remove('drop-on'); dropInto(e, target); });
  return el;
}

function editFolderStyle(node) {
  const cur = { ...folderStyle(node.path) };
  const body = h('div', {});
  const draw = () => body.replaceChildren(
    h('div', { class: 'field' }, h('label', {}, 'Color'), h('div', { class: 'colors' }, TAG_COLORS.map((c) => h('button', {
      class: 'swatch' + (c ? '' : ' none') + ((cur.color || '') === c ? ' on' : ''), style: c ? { background: c } : null, title: c || 'Color del tema',
      onclick: () => { cur.color = c; draw(); },
    })))),
    h('div', { class: 'field' }, h('label', {}, 'Ícono'), h('div', { class: 'icon-pick' }, FOLDER_ICONS.map((n) => h('button', {
      class: 'icon-btn' + ((cur.icon || 'folder') === n ? ' on' : ''), title: n, style: cur.color ? { color: cur.color } : null,
      onclick: () => { cur.icon = n; draw(); },
    }, icon(n, 18))))));
  draw();
  modal({
    title: `Carpeta «${node.name}»`, iconName: 'palette', width: 440, body,
    actions: [{ label: 'Cancelar', ghost: true }, { label: 'Aplicar', primary: true, onClick: () => {
      const st = {};
      if (cur.color) st.color = cur.color;
      if (cur.icon && cur.icon !== 'folder') st.icon = cur.icon;
      if (Object.keys(st).length) S().folderStyles[node.path] = st; else delete S().folderStyles[node.path];
      save('settings'); renderSide();
    } }],
  });
}

function sessionRow(s, withActions = true, depth = 0) {
  const u = userOf(s);
  const sub = s.type === 'local' ? (s.wslDistro ? `WSL · ${s.wslDistro}` : (INFO.shells.find((x) => x.id === s.shell) || { label: s.shell }).label)
    : s.type === 'serial' ? `${s.serialPort || '?'} · ${s.baud || 9600} baudios`
    : `${isFilesType(s.type) ? s.type + '://' : ''}${u ? u + '@' : ''}${s.host}${s.port ? ':' + s.port : ''}`;
  const compact = S().compactSessions && withActions;
  if (withActions) sessVisible.push(s.id);
  const row = h('div', {
    class: 'sess' + (compact ? ' compact' : '') + (withActions && sessSel.has(s.id) ? ' sel' : ''), style: depth ? { marginLeft: depth * 14 + 'px' } : null,
    title: compact ? null : s.notes || '',
    dataset: withActions ? { sid: s.id } : null,
    draggable: withActions ? 'true' : null,
    ondragstart: withActions ? (e) => {
      hideHoverTip();
      // Si la sesión forma parte de la selección se mueven todas las seleccionadas
      const ids = sessSel.has(s.id) ? [...sessSel] : [s.id];
      e.dataTransfer.setData(DRAG_SESSION, ids.join(','));
      e.dataTransfer.effectAllowed = 'move';
    } : null,
    ondblclick: withActions ? () => openSession(s) : null,
    onclick: withActions ? (e) => selectSession(s.id, e) : () => openSession(s),
    oncontextmenu: (e) => {
      e.preventDefault();
      if (withActions && !sessSel.has(s.id)) { sessSel = new Set([s.id]); sessAnchor = s.id; renderSide(); }
      const many = withActions && sessSel.size > 1;
      showMenu(e.clientX, e.clientY, many ? multiSessionMenu() : sessionMenu(s));
    },
    onmouseenter: compact ? (e) => showHoverTip(e.currentTarget, s, sub) : null,
    onmouseleave: compact ? hideHoverTip : null,
  },
  h('div', { class: 'sess-ic' }, icon(TYPES[s.type].icon, compact ? 15 : 16), s.color && h('span', { class: 'tag', style: { background: s.color } })),
  h('div', { class: 'meta' }, h('div', { class: 'name' }, s.name || sub), !compact && h('div', { class: 'sub' }, credOf(s) ? icon('key', 11) : null, sub)),
  withActions && h('div', { class: 'acts' },
    h('button', { class: 'icon-btn sm', title: 'Conectar', onclick: () => openSession(s) }, icon('play', 13)),
    h('button', { class: 'icon-btn sm' + (s.favorite ? ' fav' : ''), title: 'Favorito', onclick: () => { s.favorite = !s.favorite; save('sessions'); renderAll(); } }, icon('star', 13)),
    h('button', { class: 'icon-btn sm', title: 'Editar', onclick: () => editSession(s) }, icon('edit', 13))));
  return row;
}

// ------------------------------------------------------------ selección de sesiones
let sessSel = new Set();
let sessAnchor = null;
let sessVisible = [];   // orden visible de las sesiones en el último render (para Mayús+clic)

function selectSession(id, e) {
  if (e.ctrlKey || e.metaKey) { sessSel.has(id) ? sessSel.delete(id) : sessSel.add(id); sessAnchor = id; }
  else if (e.shiftKey && sessAnchor) {
    const order = [...new Set(sessVisible)];
    const [a, b] = [order.indexOf(sessAnchor), order.indexOf(id)].sort((x, y) => x - y);
    if (a >= 0) order.slice(a, b + 1).forEach((x) => sessSel.add(x));
  } else { sessSel = new Set([id]); sessAnchor = id; }
  // Se repinta sin reconstruir la lista para no romper el doble clic
  for (const el of document.querySelectorAll('#sideInner .sess[data-sid]')) el.classList.toggle('sel', sessSel.has(el.dataset.sid));
  const body = $('#sideInner .side-body');
  if (body) body.focus({ preventScroll: true });
}

async function deleteSessions(ids) {
  const list = D.sessions.filter((s) => ids.includes(s.id));
  if (!list.length) return;
  if (list.length === 1) return deleteSession(list[0]);
  const names = list.slice(0, 5).map((s) => '«' + (s.name || s.host || sessionTitle(s)) + '»').join(', ') + (list.length > 5 ? ` y ${list.length - 5} más` : '');
  if (!(await confirmBox('Eliminar sesiones', `¿Eliminar ${list.length} sesiones (${names})? Esta acción no se puede deshacer.`, { okLabel: `Eliminar ${list.length} sesiones`, danger: true }))) return;
  const gone = new Set(list.map((s) => s.id));
  D.sessions = D.sessions.filter((s) => !gone.has(s.id));
  D.recent = D.recent.filter((x) => !gone.has(x));
  sessSel = new Set();
  save('sessions'); save('recent');
  renderAll();
  toast(`${list.length} sesiones eliminadas`, 'ok');
}

function multiSessionMenu() {
  const list = D.sessions.filter((s) => sessSel.has(s.id));
  return [
    { label: `Conectar ${list.length} sesiones`, icon: 'play', action: () => list.forEach(openSession) },
    { label: 'Asignar credencial…', icon: 'key', action: () => assignCredential(list, `${list.length} sesiones seleccionadas`) },
    { label: 'Mover a carpeta…', icon: 'folder', action: async () => {
      const to = await promptText('Mover a carpeta', 'Carpeta de destino (vacío = raíz), p. ej. Clientes/ACME', list[0].folder || '');
      if (to == null) return;
      const target = to.trim().replace(/^\/+|\/+$/g, '');
      list.forEach((s) => { s.folder = target; });
      save('sessions'); renderSide();
    } },
    { sep: true },
    { label: `Eliminar ${list.length} sesiones`, icon: 'trash', danger: true, hint: 'Supr', action: () => deleteSessions(list.map((s) => s.id)) },
  ];
}

// Tarjeta flotante con usuario@servidor en la vista compacta
let hoverTimer = null;
function showHoverTip(row, s, sub) {
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => {
    hideHoverTip();
    const c = credOf(s);
    const tip = h('div', { class: 'hover-tip', id: 'hoverTip' },
      h('div', { class: 'sub' }, c ? icon('key', 11) : null, sub),
      c && h('div', { class: 'note' }, `Credencial: ${c.name}`),
      s.notes && h('div', { class: 'note' }, s.notes));
    document.body.append(tip);
    const r = row.getBoundingClientRect();
    const top = Math.min(r.bottom + 2, window.innerHeight - tip.offsetHeight - 8);
    tip.style.left = Math.max(8, r.left + 34) + 'px';
    tip.style.top = top + 'px';
  }, 300);
}
function hideHoverTip() { clearTimeout(hoverTimer); const t = $('#hoverTip'); if (t) t.remove(); }

function sessionMenu(s) {
  return [
    { label: 'Conectar', icon: 'play', action: () => openSession(s) },
    s.type === 'ssh' && { label: 'Abrir como túnel SOCKS…', icon: 'tunnel', action: () => editTunnel({ sessionId: s.id, kind: 'dynamic', listenPort: 1080 }) },
    { label: s.favorite ? 'Quitar de favoritos' : 'Añadir a favoritos', icon: 'star', action: () => { s.favorite = !s.favorite; save('sessions'); renderAll(); } },
    { sep: true },
    { label: 'Editar…', icon: 'edit', action: () => editSession(s) },
    { label: 'Duplicar…', icon: 'copy', action: () => editSession({ ...s, id: undefined, favorite: false, name: (s.name || s.host || sessionTitle(s)) + ' (copia)' }, { title: 'Duplicar sesión' }) },
    s.host && { label: 'Copiar dirección', icon: 'copy', action: () => { const u = credOf(s) ? credOf(s).user : s.user; api('clip:write', `${u ? u + '@' : ''}${s.host}`); } },
    CRED_TYPES.includes(s.type) && { label: 'Asignar credencial…', icon: 'key', action: () => assignCredential([s], s.name || s.host) },
    { sep: true },
    { label: 'Eliminar', icon: 'trash', danger: true, action: () => deleteSession(s) },
  ];
}

async function deleteSession(s) {
  if (!(await confirmBox('Eliminar sesión', `¿Eliminar «${s.name || s.host}»? Esta acción no se puede deshacer.`, { okLabel: 'Eliminar', danger: true }))) return;
  D.sessions = D.sessions.filter((x) => x.id !== s.id);
  D.recent = D.recent.filter((x) => x !== s.id);
  save('sessions'); save('recent');
  renderAll();
}

// Árbol de carpetas a partir de rutas «A/B/C»
function folderTree(list) {
  const root = { path: '', children: new Map(), sessions: [], count: 0 };
  for (const s of list) {
    let node = root;
    node.count++;
    for (const part of String(s.folder || '').split('/').filter(Boolean)) {
      const path = node.path ? `${node.path}/${part}` : part;
      if (!node.children.has(part)) node.children.set(part, { name: part, path, children: new Map(), sessions: [], count: 0 });
      node = node.children.get(part);
      node.count++;
    }
    node.sessions.push(s);
  }
  return root;
}

function folderMenu(node) {
  const inside = D.sessions.filter((s) => s.folder === node.path || String(s.folder || '').startsWith(node.path + '/'));
  return [
    { label: 'Nueva sesión aquí…', icon: 'plus', action: () => editSession({ folder: node.path }) },
    { label: 'Asignar credencial a la carpeta…', icon: 'key', action: () => assignCredential(inside, node.path) },
    { label: `Conectar las ${inside.length} sesiones`, icon: 'play', action: async () => {
      if (inside.length > 8 && !(await confirmBox('Conectar carpeta', `Se abrirán ${inside.length} pestañas.`, { okLabel: 'Conectar' }))) return;
      for (const s of inside) openSession(s);
    } },
    { sep: true },
    { label: 'Color e ícono…', icon: 'palette', action: () => editFolderStyle(node) },
    { label: 'Renombrar carpeta…', icon: 'edit', action: async () => {
      const name = ((await promptText('Renombrar carpeta', 'Nuevo nombre', node.name)) || '').trim();
      if (!name || name.includes('/')) return;
      const base = node.path.split('/').slice(0, -1).concat(name).join('/');
      if (base !== node.path && D.sessions.some((x) => inFolder(x, base))) return toast(`Ya existe la carpeta «${base}»`, 'warn');
      moveFolder(node.path, base);
      renderAll();
    } },
    node.path.includes('/') && { label: 'Mover a la raíz', icon: 'arrowUp', action: () => { const to = node.name; if (D.sessions.some((x) => inFolder(x, to))) return toast(`Ya existe la carpeta «${to}»`, 'warn'); moveFolder(node.path, to); renderAll(); } },
  ];
}

function sessionsPanel() {
  const q = sessionFilter.toLowerCase();
  const match = (s) => !q || [s.name, s.host, userOf(s), s.folder, s.notes].some((v) => v && String(v).toLowerCase().includes(q));
  const list = D.sessions.filter(match).sort((a, b) => (a.name || a.host || '').localeCompare(b.name || b.host || '', 'es'));
  const open = S().openFolders;
  sessVisible = [];
  for (const id of [...sessSel]) if (!D.sessions.some((s) => s.id === id)) sessSel.delete(id);
  const body = h('div', { class: 'side-body', tabindex: '0' });
  body.addEventListener('keydown', (e) => {
    if (e.target !== body) return;
    if (e.key === 'Delete' && sessSel.size) { e.preventDefault(); deleteSessions([...sessSel]); }
    else if (e.key === 'Escape') { sessSel = new Set(); renderSide(); }
    else if (e.ctrlKey && e.code === 'KeyA') { e.preventDefault(); sessSel = new Set(sessVisible); renderSide(); $('#sideInner .side-body').focus(); }
    else if (e.key === 'Enter' && sessSel.size) { e.preventDefault(); D.sessions.filter((s) => sessSel.has(s.id)).forEach(openSession); }
  });
  if (!D.sessions.length) {
    body.append(h('div', { class: 'empty' }, icon('server', 30), 'Todavía no tienes sesiones guardadas.',
      h('button', { class: 'btn primary sm', onclick: () => editSession() }, icon('plus', 14), 'Crear sesión'),
      h('button', { class: 'btn sm', onclick: openImport }, icon('import', 14), 'Importar sesiones')));
  } else if (!list.length) {
    body.append(h('div', { class: 'empty' }, icon('search', 26), 'Sin resultados'));
  }
  const favs = list.filter((s) => s.favorite);
  if (favs.length) {
    const isOpen = !!q || open['★'] !== false;
    body.append(h('div', { class: 'group-head' + (isOpen ? '' : ' collapsed'), onclick: () => { open['★'] = !isOpen; save('settings'); renderSide(); } },
      icon('chevronDown', 13, 'chev'), '★ Favoritos', h('span', { class: 'count' }, favs.length)));
    if (isOpen) for (const s of favs) body.append(dropTarget(sessionRow(s), s.folder || ''));
  }
  const walk = (node, depth) => {
    for (const k of [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name, 'es'))) {
      const isOpen = !!q || !!open[k.path];
      const fs = folderStyle(k.path);
      const head = h('div', {
        class: 'group-head folder' + (isOpen ? '' : ' collapsed'), style: { paddingLeft: 6 + depth * 14 + 'px' }, title: k.path, draggable: 'true',
        ondragstart: (e) => { e.dataTransfer.setData(DRAG_FOLDER, k.path); e.dataTransfer.effectAllowed = 'move'; },
        onclick: () => { open[k.path] = !isOpen; save('settings'); renderSide(); },
        oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); showMenu(e.clientX, e.clientY, folderMenu(k)); },
      }, icon('chevronDown', 13, 'chev'), h('span', { class: 'fold-wrap', style: fs.color ? { color: fs.color } : null }, icon(fs.icon || 'folder', 14, 'fold')),
      h('span', { class: 'fname' }, k.name), h('span', { class: 'count' }, k.count));
      body.append(dropTarget(head, k.path));
      if (isOpen) walk(k, depth + 1);
    }
    for (const s of node.sessions) body.append(dropTarget(sessionRow(s, true, depth), s.folder || ''));
  };
  dropTarget(body, '');
  walk(folderTree(list), 0);
  const allFolders = () => [...new Set(D.sessions.flatMap((s) => String(s.folder || '').split('/').filter(Boolean).map((_, i, a) => a.slice(0, i + 1).join('/'))))];
  const search = h('input', { placeholder: 'Buscar sesiones…', value: sessionFilter, 'data-key': 'sessfilter', spellcheck: 'false' });
  search.addEventListener('input', () => { sessionFilter = search.value; renderSide(); });
  return [
    sideHead('Sesiones',
      h('button', { class: 'icon-btn sm', title: 'Nueva sesión', onclick: () => editSession() }, icon('plus', 16)),
      h('button', { class: 'icon-btn sm', title: 'Más opciones', onclick: (e) => showMenu(e.clientX, e.clientY, [
        { label: 'Importar sesiones…', icon: 'import', action: openImport },
        { label: 'Importar contraseñas de MobaXterm…', icon: 'key', action: importMobaPasswords },
        { sep: true },
        { label: 'Exportar configuración completa…', icon: 'export', action: exportBackup },
        { label: 'Importar configuración…', icon: 'import', action: importBackup },
        { sep: true },
        { label: 'Contraer todas las carpetas', icon: 'chevron', action: () => { S().openFolders = { '★': open['★'] }; save('settings'); renderSide(); } },
        { label: 'Expandir todas las carpetas', icon: 'chevronDown', action: () => { allFolders().forEach((f) => { open[f] = true; }); save('settings'); renderSide(); } },
      ]) }, icon('more', 16))),
    h('div', { class: 'side-search' }, icon('search', 14), search),
    body,
  ];
}

// ------------------------------------------------------------ panel: credenciales
let credFilter = '';
let credMgrFilter = '';
const credUses = (c) => D.sessions.filter((s) => s.credentialId === c.id).length;

function credentialsPanel() {
  const q = credFilter.toLowerCase();
  const list = D.credentials.filter((c) => !q || [c.name, c.user].some((v) => v && v.toLowerCase().includes(q)))
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));
  const pending = D.credentials.filter((c) => !c.passwordEnc).length;
  const search = h('input', { placeholder: 'Buscar credenciales…', value: credFilter, 'data-key': 'credfilter', spellcheck: 'false' });
  search.addEventListener('input', () => { credFilter = search.value; renderSide(); });
  const body = h('div', { class: 'side-body' },
    pending > 0 && h('div', { class: 'cred-note' }, icon('info', 14), h('span', {}, `${pending} sin contraseña: se pedirá la primera vez que conectes y quedará guardada.`)),
    list.map((c) => h('div', { class: 'item-card', ondblclick: () => editCredential(c) },
      h('div', { class: 'top' }, icon('key', 14), h('span', { class: 'name' }, c.name),
        h('div', { class: 'acts' }, h('button', { class: 'icon-btn sm', title: 'Editar', onclick: () => editCredential(c) }, icon('edit', 14)))),
      h('div', { class: 'desc' }, `${c.user || 'usuario sin definir'} · ${c.passwordEnc ? 'contraseña guardada' : 'sin contraseña'} · ${credUses(c)} sesiones`))),
    !D.credentials.length && h('div', { class: 'empty' }, icon('key', 28),
      'Guarda usuario y contraseña una sola vez y úsalos en todas las sesiones que quieras. Si cambias la contraseña, se actualiza en todas.',
      h('button', { class: 'btn primary sm', onclick: () => editCredential() }, icon('plus', 14), 'Nueva credencial')));
  return [sideHead('Credenciales',
    h('button', { class: 'icon-btn sm', title: 'Importar contraseñas de MobaXterm', onclick: importMobaPasswords }, icon('import', 16)),
    h('button', { class: 'icon-btn sm', title: 'Nueva credencial', onclick: () => editCredential() }, icon('plus', 16))),
    h('div', { class: 'side-search' }, icon('search', 14), search), body];
}

function editCredential(existing, onSaved) {
  const isNew = !existing || !existing.id;
  const c = { name: '', user: '', ...(existing || {}) };
  const name = h('input', { class: 'input', value: c.name, autofocus: true, placeholder: 'p. ej. Linux producción' });
  const user = h('input', { class: 'input', value: c.user, spellcheck: 'false', placeholder: 'root, administrator, DOMINIO\\usuario…' });
  const pw = h('input', { class: 'input', type: 'password', placeholder: c.passwordEnc ? '•••••••• (guardada — escribe para cambiar)' : 'Vacío = preguntar la primera vez' });
  const forget = h('input', { type: 'checkbox' });
  const uses = isNew ? 0 : credUses(c);
  modal({
    title: isNew ? 'Nueva credencial' : 'Editar credencial', iconName: 'key', width: 480,
    body: h('div', {},
      h('div', { class: 'field' }, h('label', {}, 'Nombre'), name),
      h('div', { class: 'field' }, h('label', {}, 'Usuario'), user),
      h('div', { class: 'field' }, h('label', {}, 'Contraseña'), pw, h('div', { class: 'hint' }, 'Se guarda cifrada con la protección de datos de Windows (DPAPI), sólo legible por tu usuario.')),
      c.passwordEnc && h('label', { class: 'check' }, forget, 'Olvidar la contraseña guardada'),
      uses > 0 && h('p', { class: 'hint' }, `La usan ${uses} sesiones.`)),
    actions: [
      !isNew && { label: 'Eliminar', icon: 'trash', ghost: true, left: true, onClick: async () => {
        if (uses && !(await confirmBox('Eliminar credencial', `${uses} sesiones la usan y volverán a pedir usuario y contraseña.`, { okLabel: 'Eliminar', danger: true }))) return false;
        D.credentials = D.credentials.filter((x) => x.id !== c.id);
        for (const s of D.sessions) if (s.credentialId === c.id) delete s.credentialId;
        save('credentials'); save('sessions'); renderAll();
      } },
      { label: 'Cancelar', ghost: true },
      { label: 'Guardar', primary: true, onClick: async () => {
        if (!name.value.trim()) throw new Error('Ponle un nombre');
        c.name = name.value.trim();
        c.user = user.value.trim();
        if (forget.checked) c.passwordEnc = '';
        if (pw.value) c.passwordEnc = await api('secret:encrypt', pw.value);
        if (isNew) { c.id = uid(); D.credentials.push(c); } else { const i = D.credentials.findIndex((x) => x.id === c.id); D.credentials[i] = c; }
        save('credentials'); renderAll();
        if (onSaved) onSaved(c);
      } },
    ].filter(Boolean),
  });
}

// Selector de credencial; «Nueva credencial…» abre el editor y la selecciona al guardar
function credentialSelect(value, onChange) {
  const sel = h('select', { class: 'select' },
    h('option', { value: '' }, '— Ninguna: usuario y contraseña propios —'),
    [...D.credentials].sort((a, b) => a.name.localeCompare(b.name, 'es')).map((c) => h('option', { value: c.id }, `${c.name}${c.user ? ' (' + c.user + ')' : ''}`)),
    h('option', { value: '__new' }, '+ Nueva credencial…'));
  sel.value = value || '';
  sel.addEventListener('change', () => {
    if (sel.value === '__new') { sel.value = value || ''; editCredential(null, (c) => onChange(c.id)); return; }
    onChange(sel.value);
  });
  return sel;
}

function assignCredential(list, label) {
  const targets = list.filter((s) => CRED_TYPES.includes(s.type));
  let chosen = '';
  const slot = h('div', {});
  const place = (v) => { chosen = v; slot.replaceChildren(credentialSelect(v, place)); };
  place('');
  modal({
    title: 'Asignar credencial', iconName: 'key', width: 480,
    body: h('div', {}, h('p', { class: 'hint' }, `Se aplicará a ${targets.length} sesiones SSH, SFTP, FTP y RDP de «${label}».`), h('div', { class: 'field' }, h('label', {}, 'Credencial'), slot)),
    actions: [{ label: 'Cancelar', ghost: true }, { label: 'Aplicar', primary: true, onClick: () => {
      for (const s of targets) { if (chosen) s.credentialId = chosen; else delete s.credentialId; }
      save('sessions'); renderAll();
      toast(chosen ? 'Credencial asignada' : 'Credencial quitada', 'ok');
    } }],
  });
}

// El proceso principal guarda en la credencial el usuario/contraseña escritos al conectar
rx.on('store:changed', (key, value) => {
  if (key !== 'credentials') return;
  D.credentials = value || [];
  renderAll();
  toast('Credencial guardada para las próximas conexiones', 'ok', 2500);
});

// ------------------------------------------------------------ editor de sesión
function editSession(existing, opts = {}) {
  const isNew = !existing || !existing.id;
  const s = { type: 'ssh', port: '', auth: 'password', keepalive: 30, shell: S().defaultShell, baud: 9600, dataBits: 8, parity: 'none', stopBits: 1, flow: 'none', ...(existing || {}) };
  delete s.id;
  if (!isNew) s.id = existing.id;
  let serialPorts = null;
  let password = '';
  let passphrase = '';
  const folders = [...new Set(D.sessions.map((x) => x.folder).filter(Boolean))];
  const body = h('div', { 'data-noenter': '' });

  const input = (key, attrs = {}) => {
    const el = h('input', { class: 'input', value: s[key] ?? '', spellcheck: 'false', ...attrs });
    el.addEventListener('input', () => { s[key] = el.value; });
    return el;
  };
  const field = (label, el, hint) => h('div', { class: 'field' }, h('label', {}, label), el, hint && h('div', { class: 'hint' }, hint));
  const check = (key, label) => {
    const el = h('input', { type: 'checkbox', checked: !!s[key] });
    el.addEventListener('change', () => { s[key] = el.checked; });
    return h('label', { class: 'check' }, el, label);
  };

  function render() {
    const seg = h('div', { class: 'seg' }, Object.entries(TYPES).map(([k, v]) => h('button', {
      class: s.type === k ? 'on' : '', onclick: () => { s.type = k; s.port = ''; render(); },
    }, icon(v.icon, 20), v.label)));
    const parts = [seg];
    if (s.type !== 'local' && s.type !== 'serial') {
      parts.push(h('div', { class: 'grid3' },
        field('Servidor (host o IP)', input('host', { placeholder: '192.168.1.10 o servidor.empresa.cl', autofocus: true })),
        field('Puerto', input('port', { type: 'number', placeholder: String(DEFAULT_PORTS[s.type]), min: 1, max: 65535 }))));
      if (CRED_TYPES.includes(s.type)) {
        parts.push(field('Credencial', credentialSelect(s.credentialId, (v) => { s.credentialId = v; render(); }),
          s.credentialId ? 'Usuario y contraseña vienen de la credencial: si la cambias, se actualiza en todas sus sesiones.' : null));
        const ph = { ssh: 'root, admin… (vacío = preguntar)', sftp: 'root, admin… (vacío = preguntar)', ftp: 'Vacío = acceso anónimo', rdp: 'DOMINIO\\usuario' }[s.type];
        if (!s.credentialId) parts.push(field('Usuario', input('user', { placeholder: ph })));
      }
    }
    const passwordField = () => {
      if (s.credentialId) return parts.push(h('p', { class: 'hint' }, `Se usa la contraseña de la credencial «${(credOf(s) || {}).name || ''}».`));
      const pw = h('input', { class: 'input', type: 'password', placeholder: s.passwordEnc ? '•••••••• (guardada — escribe para cambiar)' : 'Vacío = preguntar al conectar', value: password });
      pw.addEventListener('input', () => { password = pw.value; });
      parts.push(field('Contraseña', pw, 'Se guarda cifrada con la protección de datos de Windows (DPAPI), sólo legible por tu usuario.'));
      if (s.passwordEnc) parts.push(h('label', { class: 'check' }, h('input', { type: 'checkbox', onchange: (e) => { s.clearPassword = e.target.checked; } }), 'Olvidar la contraseña guardada'));
    };
    if (s.type === 'ftp') {
      passwordField();
      parts.push(check('ftpSecure', 'Usar FTPS (TLS explícito)'));
      if (s.ftpSecure) parts.push(check('ftpInsecure', 'Aceptar certificados no verificados (autofirmados)'));
      if (!s.ftpSecure) parts.push(h('p', { class: 'hint' }, 'FTP sin TLS envía usuario y contraseña sin cifrar: úsalo sólo en redes de confianza.'));
    }
    if (s.type === 'serial') {
      const portIn = input('serialPort', { list: 'seriallist', placeholder: 'COM3', autofocus: true });
      const dl = h('datalist', { id: 'seriallist' }, (serialPorts || []).map((p) => h('option', { value: p.path }, p.label)));
      if (!serialPorts) api('term:serialPorts').then((l) => { serialPorts = l; render(); }).catch(() => { serialPorts = []; });
      const select = (key, options) => {
        const el = h('select', { class: 'select' }, options.map(([v, l]) => h('option', { value: v }, l)));
        el.value = String(s[key]);
        el.addEventListener('change', () => { s[key] = /^\d+$/.test(el.value) ? Number(el.value) : el.value; });
        return el;
      };
      parts.push(h('div', { class: 'grid2' },
        field('Puerto', h('div', {}, portIn, dl), serialPorts && serialPorts.length ? `Detectados: ${serialPorts.map((p) => p.label).join(', ')}` : serialPorts ? 'No se detectaron puertos COM' : 'Buscando puertos…'),
        field('Velocidad (baudios)', select('baud', BAUD_RATES.map((b) => [b, String(b)])))));
      parts.push(h('div', { class: 'grid4' },
        field('Bits de datos', select('dataBits', [[8, '8'], [7, '7'], [6, '6'], [5, '5']])),
        field('Paridad', select('parity', [['none', 'Ninguna'], ['even', 'Par'], ['odd', 'Impar'], ['mark', 'Marca'], ['space', 'Espacio']])),
        field('Bits de parada', select('stopBits', [[1, '1'], [2, '2']])),
        field('Control de flujo', select('flow', [['none', 'Ninguno'], ['rtscts', 'RTS/CTS'], ['xonxoff', 'XON/XOFF']]))));
    }
    if (s.type === 'ssh' || s.type === 'sftp') {
      const pills = h('div', { class: 'pills' }, [['password', 'Contraseña'], ['key', 'Clave privada'], ['agent', 'Agente SSH']].map(([k, l]) =>
        h('button', { class: s.auth === k ? 'on' : '', onclick: () => { s.auth = k; render(); } }, l)));
      parts.push(field('Autenticación', pills));
      if (s.auth === 'password') {
        passwordField();
      } else if (s.auth === 'key') {
        const kp = input('keyPath', { placeholder: 'C:\\Users\\…\\.ssh\\id_ed25519' });
        parts.push(field('Archivo de clave privada', h('div', { class: 'row-inline', style: { margin: 0 } }, kp,
          h('button', { class: 'btn', onclick: async () => { const f = await api('dialog:openFile', 'Selecciona la clave privada'); if (f) { s.keyPath = f; kp.value = f; } } }, icon('folder', 14), 'Examinar')),
        'Formatos OpenSSH, PEM y PuTTY (.ppk).'));
        const pp = h('input', { class: 'input', type: 'password', placeholder: s.passphraseEnc ? '•••••••• (guardada)' : 'Opcional — vacío = preguntar si hace falta', value: passphrase });
        pp.addEventListener('input', () => { passphrase = pp.value; });
        parts.push(field('Frase de paso', pp));
      } else {
        parts.push(h('p', { class: 'hint' }, 'Usa las claves cargadas en el agente OpenSSH de Windows (servicio «ssh-agent»).'));
      }
      if (s.type === 'ssh') parts.push(h('div', { class: 'grid2' },
        field('Comando inicial', input('startupCmd', { placeholder: 'p. ej. sudo -i  ·  cd /var/www' })),
        field('Keepalive (segundos)', input('keepalive', { type: 'number', min: 5, max: 600 }))));
    }
    if (s.type === 'telnet') parts.push(h('p', { class: 'hint' }, 'Telnet no cifra el tráfico: úsalo sólo en redes de confianza.'));
    if (s.type === 'local') {
      const sel = h('select', { class: 'select' }, INFO.shells.map((x) => h('option', { value: x.id }, x.label)));
      sel.value = s.shell || S().defaultShell;
      sel.addEventListener('change', () => { s.shell = sel.value; });
      parts.push(field('Intérprete', sel));
      const cwd = input('cwd', { placeholder: INFO.home });
      parts.push(field('Directorio inicial', h('div', { class: 'row-inline', style: { margin: 0 } }, cwd,
        h('button', { class: 'btn', onclick: async () => { const d = await api('dialog:openDir', 'Directorio inicial'); if (d) { s.cwd = d; cwd.value = d; } } }, icon('folder', 14)))));
      parts.push(field('Comando inicial', input('startupCmd', { placeholder: 'opcional' })));
    }
    if (s.type === 'rdp') {
      parts.push(check('rdpFullscreen', 'Pantalla completa'));
      parts.push(check('rdpDrives', 'Compartir mis unidades locales'));
    }
    const dl = h('datalist', { id: 'folderlist' }, folders.map((f) => h('option', { value: f })));
    parts.push(h('div', { class: 'grid2', style: { marginTop: '6px' } },
      field('Nombre', input('name', { placeholder: 'Opcional — p. ej. Producción web' })),
      field('Carpeta', h('div', {}, input('folder', { list: 'folderlist', placeholder: 'p. ej. Clientes/ACME' }), dl))));
    parts.push(field('Color de etiqueta', h('div', { class: 'colors' }, TAG_COLORS.map((c) => h('button', {
      class: 'swatch' + (c ? '' : ' none') + ((s.color || '') === c ? ' on' : ''), style: c ? { background: c } : null, title: c || 'Sin color',
      onclick: () => { s.color = c; render(); },
    })))));
    const notes = h('textarea', { class: 'textarea', style: { minHeight: '54px', fontFamily: 'var(--font)' }, placeholder: 'Notas (opcional)' }, s.notes || '');
    notes.addEventListener('input', () => { s.notes = notes.value; });
    parts.push(field('Notas', notes));
    body.replaceChildren(...parts);
  }
  render();

  const persistSession = async () => {
    if (s.type === 'serial') { if (!String(s.serialPort || '').trim()) throw new Error('Indica el puerto serie (p. ej. COM3)'); s.serialPort = s.serialPort.trim().toUpperCase(); }
    else if (s.type !== 'local' && !String(s.host || '').trim()) throw new Error('Indica el servidor');
    s.host = (s.host || '').trim();
    s.port = s.port ? Number(s.port) : '';
    if (!s.credentialId) delete s.credentialId;
    if (s.clearPassword) { s.passwordEnc = ''; delete s.clearPassword; }
    if (password) s.passwordEnc = await api('secret:encrypt', password);
    if (passphrase) s.passphraseEnc = await api('secret:encrypt', passphrase);
    if (isNew) { s.id = uid(); D.sessions.push(s); }
    else { const i = D.sessions.findIndex((x) => x.id === s.id); if (i >= 0) D.sessions[i] = s; else D.sessions.push(s); }
    save('sessions');
    renderAll();
  };
  modal({
    title: opts.title || (isNew ? 'Nueva sesión' : 'Editar sesión'), width: 720, body, iconName: 'server',
    actions: [
      !isNew && { label: 'Eliminar', icon: 'trash', ghost: true, left: true, onClick: async () => { await deleteSession(s); } },
      { label: 'Cancelar', ghost: true },
      { label: 'Guardar', onClick: persistSession },
      { label: 'Guardar y conectar', primary: true, icon: 'play', onClick: async () => { await persistSession(); openSession(s); } },
    ].filter(Boolean),
  });
}

async function importMoba() {
  try {
    const res = await api('moba:import');
    if (res) applyMobaImport(res);
  } catch (e) { toast('No se pudo importar: ' + e.message, 'error'); }
}

async function importSessionsFrom(kind) {
  try {
    const res = await api('data:importSessions', kind);
    if (!res) return;
    if (!res.sessions.length) return toast(`No se encontraron sesiones para importar${res.skipped.length ? ` (${res.skipped.length} omitidas)` : ''}.`, 'warn', 6000);
    applyMobaImport(res);
  } catch (e) { toast('No se pudo importar: ' + e.message, 'error', 8000); }
}

// Asistente de importación: todas las fuentes en un solo lugar
function openImport() {
  const opt = (ic, title, desc, run) => h('button', { class: 'import-opt', onclick: () => { close(); run(); } },
    h('span', { class: 'ic-box' }, icon(ic, 20)), h('span', { class: 'txt' }, h('b', {}, title), h('span', {}, desc)));
  let close = () => {};
  const body = h('div', { class: 'import-grid' },
    opt('import', 'MobaXterm', 'Archivo .mxtsessions (y MobaXterm.ini para los usuarios)', importMoba),
    opt('key', 'Contraseñas de MobaXterm', '«MobaXterm Stored Passwords.txt» (Export to file)', importMobaPasswords),
    opt('ssh', 'PuTTY / KiTTY', 'Lee las sesiones guardadas en este equipo', () => importSessionsFrom('putty')),
    opt('terminal', 'OpenSSH config', 'Hosts de %USERPROFILE%\\.ssh\\config', () => importSessionsFrom('sshconfig')),
    opt('server', 'mRemoteNG', 'confCons.xml o exportación CSV (sin contraseñas)', () => importSessionsFrom('file')),
    opt('database', 'Excel, CSV o JSON', 'Columnas: nombre, host, puerto, usuario, protocolo, carpeta, notas, contraseña', () => importSessionsFrom('file')),
    opt('monitor', 'Archivos .rdp', 'Uno o varios archivos de Escritorio remoto', () => importSessionsFrom('file')),
    opt('file', 'PuTTY exportado (.reg)', 'Archivo .reg exportado desde otro equipo', () => importSessionsFrom('file')),
    opt('shield', 'Respaldo de ReaXTerm', 'Archivo .rxbackup cifrado con contraseña', importBackup));
  const m = modal({
    title: 'Importar sesiones', iconName: 'import', width: 680,
    body: h('div', {}, body, h('p', { class: 'hint', style: { marginTop: '10px' } }, 'Las sesiones que ya existen se actualizan en lugar de duplicarse. Las contraseñas que vengan en CSV, Excel o JSON se guardan cifradas con DPAPI; borra después ese archivo si las contiene.')),
    actions: [{ label: 'Cerrar', ghost: true }],
  });
  close = () => m.close(null);
}

function applyMobaImport(res) {
  // Credenciales referenciadas como «[Nombre]» en MobaXterm
  const byName = new Map(D.credentials.map((c) => [c.name, c]));
  let newCreds = 0;
  for (const c of res.credentials) {
    const cur = byName.get(c.name);
    if (!cur) { const x = { id: uid(), name: c.name, user: c.user || '', importedFrom: 'MobaXterm' }; D.credentials.push(x); byName.set(c.name, x); newCreds++; }
    else if (!cur.user && c.user) cur.user = c.user;
  }
  for (const s of res.sessions) if (s.credentialName) { s.credentialId = byName.get(s.credentialName).id; delete s.credentialName; }
  // Una sesión ya importada se actualiza (carpeta, credencial) en vez de duplicarse
  const key = (s) => [s.type, s.host, s.port, s.name].join('|');
  const existing = new Map(D.sessions.map((s) => [key(s), s]));
  let added = 0, updated = 0;
  for (const s of res.sessions) {
    const old = existing.get(key(s));
    if (!old) { D.sessions.push(s); existing.set(key(s), s); added++; continue; }
    old.folder = s.folder;
    if (s.credentialId) { old.credentialId = s.credentialId; if (/^\[.*\]$/.test(old.user || '')) old.user = ''; }
    else if (!old.user || /^\[.*\]$/.test(old.user)) old.user = s.user;
    if (s.wslDistro) old.wslDistro = s.wslDistro;
    if (s.passwordEnc && !old.passwordEnc) old.passwordEnc = s.passwordEnc;
    updated++;
  }
  save('sessions'); save('credentials');
  setPanel('sessions');
  toast([
    `${res.source || 'MobaXterm'}: ${added} sesiones nuevas${updated ? `, ${updated} actualizadas` : ''}`,
    res.passwords ? `${res.passwords} contraseñas guardadas cifradas` : '',
    res.credentials.length ? `${res.credentials.length} credenciales (${newCreds} nuevas)` : '',
    res.skipped.length ? `${res.skipped.length} omitidas (tipo no soportado o sin servidor)` : '',
  ].filter(Boolean).join(' · ') + '.', 'ok', 7000);
  if (!res.source && res.credentials.length) {
    const noUser = D.credentials.filter((c) => !c.user).length;
    toast(noUser
      ? 'Las contraseñas de MobaXterm no se pueden importar. Escríbelas una vez por credencial en el panel Credenciales (o al conectar). Para traer los usuarios, importa también tu MobaXterm.ini.'
      : 'Las contraseñas de MobaXterm no se pueden importar: se pedirán una vez por credencial al conectar y quedarán guardadas.', 'info', 12000);
  }
}

// Combina por id: lo que ya existe se conserva, pero recibe las contraseñas que le falten
function mergeById(current, incoming, secretFields) {
  const byId = new Map(current.map((x) => [x.id, x]));
  let added = 0;
  for (const item of incoming || []) {
    const cur = byId.get(item.id);
    if (!cur) { current.push(item); byId.set(item.id, item); added++; continue; }
    for (const f of secretFields) if (!cur[f] && item[f]) cur[f] = item[f];
  }
  return added;
}

async function importBackup() {
  let d;
  try { d = await api('data:import'); } catch (e) { toast('No se pudo importar: ' + e.message, 'error'); return; }
  if (!d) return;
  const n = (d.sessions || []).length, c = (d.credentials || []).length;
  const apply = (replace) => {
    if (replace) {
      D.sessions = d.sessions || [];
      D.credentials = d.credentials || [];
      D.snippets = d.snippets || [];
      D.tunnels = d.tunnels || [];
      D.recent = d.recent || [];
      if (d.settings) D.settings = { ...DEFAULT_SETTINGS, ...d.settings };
    } else {
      mergeById(D.sessions, d.sessions, ['passwordEnc', 'passphraseEnc']);
      mergeById(D.credentials, d.credentials, ['passwordEnc']);
      mergeById(D.snippets, d.snippets, []);
      mergeById(D.tunnels, d.tunnels, []);
    }
    for (const k of ['sessions', 'credentials', 'snippets', 'tunnels', 'recent', 'settings']) save(k);
    applyTheme();
    renderAll();
    toast(`Configuración importada: ${n} sesiones, ${c} credenciales${replace ? ' (reemplazo completo)' : ''}`, 'ok', 6000);
  };
  modal({
    title: 'Importar configuración', iconName: 'import', width: 500,
    body: h('div', {},
      h('p', {}, `El archivo trae ${n} sesiones, ${c} credenciales, ${(d.snippets || []).length} comandos y ${(d.tunnels || []).length} túneles.`),
      h('p', { class: 'hint' }, '«Combinar» agrega lo que no tienes y completa contraseñas faltantes sin tocar lo demás. «Reemplazar todo» deja exactamente lo del archivo, incluidos los ajustes.')),
    actions: [
      { label: 'Reemplazar todo', ghost: true, left: true, onClick: async () => {
        if (!(await confirmBox('Reemplazar todo', 'Se borrarán tus sesiones, credenciales, comandos y túneles actuales y se usarán los del archivo.', { okLabel: 'Reemplazar', danger: true }))) return false;
        apply(true);
      } },
      { label: 'Cancelar', ghost: true },
      { label: 'Combinar', primary: true, onClick: () => apply(false) },
    ],
  });
}

function exportBackup() {
  const pw1 = h('input', { class: 'input', type: 'password', autofocus: true, placeholder: 'Mínimo 8 caracteres' });
  const pw2 = h('input', { class: 'input', type: 'password', placeholder: 'Repite la contraseña' });
  modal({
    title: 'Exportar configuración completa', iconName: 'shield', width: 500,
    body: h('div', {},
      h('p', {}, 'Incluye sesiones, credenciales con sus contraseñas, comandos, túneles, ajustes y servidores conocidos. El archivo se cifra con AES-256 usando esta contraseña.'),
      h('div', { class: 'field' }, h('label', {}, 'Contraseña del respaldo'), pw1),
      h('div', { class: 'field' }, h('label', {}, 'Confirmar contraseña'), pw2,
        h('div', { class: 'hint' }, 'Sin esta contraseña el archivo no se puede abrir: no hay forma de recuperarla.'))),
    actions: [
      { label: 'Cancelar', ghost: true },
      { label: 'Exportar', primary: true, onClick: async () => {
        if (pw1.value.length < 8) throw new Error('La contraseña debe tener al menos 8 caracteres');
        if (pw1.value !== pw2.value) throw new Error('Las contraseñas no coinciden');
        const r = await api('data:export', pw1.value);
        if (!r) return false;
        toast(`Respaldo cifrado guardado: ${r.file} (${r.sessions} sesiones, ${r.credentials} credenciales)`, 'ok', 8000);
      } },
    ],
  });
}

// ---- contraseñas exportadas desde MobaXterm («Export to file»)
async function importMobaPasswords() {
  let res;
  try { res = await api('moba:importPasswords'); } catch (e) { toast('No se pudo importar: ' + e.message, 'error'); return; }
  if (!res) return;
  // Credenciales: por nombre
  const byName = new Map(D.credentials.map((c) => [c.name, c]));
  let credsFilled = 0, credsNew = 0;
  for (const c of res.credentials) {
    const cur = byName.get(c.name);
    if (cur) { cur.passwordEnc = c.passwordEnc; if (!cur.user) cur.user = c.user; credsFilled++; }
    else { const x = { id: uid(), name: c.name, user: c.user, passwordEnc: c.passwordEnc, importedFrom: 'MobaXterm' }; D.credentials.push(x); byName.set(c.name, x); credsNew++; }
  }
  // Contraseñas por servidor: sesiones SSH/RDP sin credencial con el mismo servidor y usuario
  const protoOk = (s, proto) => !proto || (s.type === 'rdp' ? proto === 'rdp' : proto.startsWith('ssh'));
  let sessFilled = 0;
  for (const s of D.sessions) {
    if (s.credentialId || !s.host || (s.type !== 'ssh' && s.type !== 'rdp')) continue;
    const cands = res.passwords.filter((p) => p.host === s.host.toLowerCase() && protoOk(s, p.proto));
    const byUser = s.user ? cands.filter((p) => p.user.toLowerCase() === s.user.toLowerCase()) : [];
    const users = [...new Set(cands.map((p) => p.user))];
    const pick = byUser[0] || (!s.user && users.length === 1 ? cands[0] : null);
    if (!pick) continue;
    if (!s.user) s.user = pick.user;
    s.passwordEnc = pick.passwordEnc;
    if (s.type === 'ssh') s.auth = s.auth || 'password';
    sessFilled++;
  }
  save('credentials'); save('sessions');
  setPanel('credentials');
  const missing = D.credentials.filter((c) => !c.passwordEnc && credUses(c) > 0).map((c) => c.name);
  toast(`Contraseñas importadas: ${credsFilled} credenciales${credsNew ? ` (+${credsNew} nuevas)` : ''} y ${sessFilled} sesiones.${missing.length ? ` Sin contraseña en MobaXterm: ${missing.join(', ')}.` : ''}`, 'ok', 9000);
  // El archivo exportado tiene las contraseñas en texto plano
  if (await confirmBox('Archivo con contraseñas en texto plano', `«${res.file.split(/[\\/]/).pop()}» contiene tus contraseñas sin cifrar. ReaXTerm ya las guardó cifradas. ¿Enviarlo a la papelera ahora? (Recuerda vaciarla después.)`, { okLabel: 'Enviar a la papelera', danger: true })) {
    try { await api('moba:deleteFile', res.file); toast('Archivo enviado a la papelera: vacíala para eliminarlo definitivamente', 'ok', 6000); } catch (e) { toast(e.message, 'error'); }
  }
}

// ------------------------------------------------------------ panel: SFTP
async function ensureSftp(tabId) {
  let st = sftp.get(tabId);
  if (!st) { await sftpLoad(tabId, '.'); st = sftp.get(tabId); }
  return st && !st.error ? st : null;
}

async function sftpLoad(tabId, dir) {
  const prev = sftp.get(tabId) || { sel: new Set(), filter: '' };
  sftp.set(tabId, { ...prev, loading: true, error: null });
  renderSftp(tabId);
  try {
    const r = await api('sftp:list', tabId, dir);
    sftp.set(tabId, { cwd: r.path, entries: r.entries, sel: new Set(), loading: false, error: null, filter: prev.cwd === r.path ? prev.filter : '' });
  } catch (e) {
    sftp.set(tabId, { ...prev, loading: false, error: e.message });
    if (prev.cwd) toast(e.message, 'error');
  }
  renderSftp(tabId);
}

const joinPath = (dir, name) => (dir.endsWith('/') ? dir : dir + '/') + name;
const parentPath = (p) => { if (p === '/') return '/'; const i = p.replace(/\/$/, '').lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); };

async function uploadFiles(tabId, dir, files) {
  try {
    const n = await api('sftp:upload', tabId, dir, files);
    if (n) { toast(`${n} elemento(s) subido(s) a ${dir}`, 'ok'); sftpLoad(tabId, dir); }
  } catch (e) { toast('Error al subir: ' + e.message, 'error'); }
}

rx.on('sftp:progress', (p) => {
  const x = transfers.get(p.tid) || { name: p.name, done: 0, total: 0 };
  Object.assign(x, p);
  transfers.set(p.tid, x);
  if (p.finished) setTimeout(() => { transfers.delete(p.tid); renderTransfers(); }, 4000);
  renderTransfers();
});

function renderTransfers() {
  const box = $('#transfers');
  if (!box) return;
  box.classList.toggle('show', transfers.size > 0);
  box.replaceChildren(...[...transfers.values()].map((x) => {
    const pct = x.finished && !x.error ? 100 : x.total ? Math.round((x.done / x.total) * 100) : 0;
    return h('div', { class: 'xfer' + (x.finished ? (x.error ? ' fail' : ' done') : '') },
      h('div', { class: 'row' }, h('span', {}, x.name), h('span', {}, x.error ? 'Error' : x.finished ? 'Completado' : `${pct}% · ${fmtSize(x.done)}`)),
      h('div', { class: 'bar' }, h('i', { style: { width: pct + '%' } })));
  }));
}

// Las pestañas SFTP/FTP muestran el explorador en el área principal; las SSH, en el panel lateral
function renderSftp(tabId) {
  if (panel === 'sftp') renderSide();
  const t = tabs.get(tabId);
  if (t && isFilesType(t.session.type)) renderFilesPane(t);
}

function renderFilesPane(t) {
  const box = t.el.querySelector('.pane-files');
  const focused = document.activeElement;
  const focusKey = focused && box.contains(focused) ? focused.dataset.key : null;
  const selStart = focusKey ? focused.selectionStart : null;
  const old = box.querySelector('.sftp-list');
  const scroll = old ? old.scrollTop : 0;
  box.replaceChildren(...sftpPanel(t));
  const list = box.querySelector('.sftp-list');
  if (list) list.scrollTop = scroll;
  if (focusKey) { const el = box.querySelector(`[data-key="${focusKey}"]`); if (el) { el.focus(); try { el.setSelectionRange(selStart, selStart); } catch { /* ignore */ } } }
}

function sftpPanel(paneTab) {
  const t = paneTab || tabs.get(activeId);
  const title = paneTab ? `Explorador ${TYPES[t.session.type].label}` : 'Explorador SFTP';
  const rerender = () => renderSftp(t.id);
  if (!paneTab && t && isFilesType(t.session.type)) {
    return [sideHead('Explorador SFTP'), h('div', { class: 'side-body' }, h('div', { class: 'empty' }, icon('folder', 30), 'El explorador de esta sesión está en la pestaña principal.'))];
  }
  if (paneTab && t.state !== 'connected') {
    return [sideHead(title), h('div', { class: 'side-body' }, h('div', { class: 'empty' }, icon(t.state === 'connecting' ? 'clock' : 'lock', 28),
      t.state === 'connecting' ? 'Conectando…' : (t.statusText || 'La sesión está desconectada.'),
      t.state === 'closed' && h('div', { class: 'row-inline', style: { justifyContent: 'center' } },
        h('button', { class: 'btn primary sm', onclick: () => reconnect(t) }, icon('refresh', 14), 'Reconectar'),
        h('button', { class: 'btn sm', onclick: () => closeTab(t.id, { force: true }) }, icon('x', 14), 'Cerrar pestaña'))))];
  }
  if (!t || t.session.type !== 'ssh' && !paneTab) {
    return [sideHead('Explorador SFTP'), h('div', { class: 'side-body' }, h('div', { class: 'empty' }, icon('folder', 30),
      'Activa una pestaña SSH para explorar y transferir archivos del servidor.',
      h('button', { class: 'btn sm', onclick: () => setPanel('sessions') }, icon('server', 14), 'Ir a sesiones')))];
  }
  if (t.state !== 'connected') {
    return [sideHead('Explorador SFTP'), h('div', { class: 'side-body' }, h('div', { class: 'empty' }, icon('lock', 28), t.state === 'connecting' ? 'Conectando…' : 'La sesión está desconectada.'))];
  }
  const st = sftp.get(t.id);
  if (!st) { sftpLoad(t.id, '.'); return [sideHead(title), h('div', { class: 'side-body' }, h('div', { class: 'empty' }, 'Abriendo explorador…'))]; }
  const id = t.id;
  const reload = () => sftpLoad(id, st.cwd);
  const pathInput = h('input', { value: st.cwd || '', spellcheck: 'false', 'data-key': 'sftppath' });
  pathInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sftpLoad(id, pathInput.value.trim() || '/'); });
  const filterInput = h('input', { placeholder: 'Filtrar…', value: st.filter || '', 'data-key': 'sftpfilter', spellcheck: 'false' });
  filterInput.addEventListener('input', () => { st.filter = filterInput.value; rerender(); });

  const selected = () => st.entries.filter((e) => st.sel.has(e.name)).map((e) => ({ ...e, path: joinPath(st.cwd, e.name) }));
  const newFolder = async () => { const n = await promptText('Nueva carpeta', 'Nombre'); if (n) { try { await api('sftp:mkdir', id, joinPath(st.cwd, n)); reload(); } catch (e) { toast(e.message, 'error'); } } };
  const newFile = async () => { const n = await promptText('Nuevo archivo', 'Nombre'); if (n) { try { await api('sftp:touch', id, joinPath(st.cwd, n)); reload(); } catch (e) { toast(e.message, 'error'); } } };
  const download = async (items) => { try { const r = await api('sftp:download', id, items); if (r) toast('Descargado en ' + r, 'ok', 5000); } catch (e) { toast(e.message, 'error'); } };
  const remove = async (items) => {
    if (!items.length) return;
    const ok = await confirmBox('Eliminar', `¿Eliminar ${items.length === 1 ? '«' + items[0].name + '»' : items.length + ' elementos'} del servidor?${items.some((i) => i.isDir) ? ' Las carpetas se borrarán con todo su contenido.' : ''}`, { okLabel: 'Eliminar', danger: true });
    if (!ok) return;
    try { await api('sftp:delete', id, items); toast('Eliminado', 'ok'); reload(); } catch (e) { toast(e.message, 'error'); reload(); }
  };
  const rename = async (it) => {
    const n = await promptText('Renombrar', 'Nuevo nombre', it.name);
    if (n && n !== it.name) { try { await api('sftp:rename', id, it.path, joinPath(st.cwd, n)); reload(); } catch (e) { toast(e.message, 'error'); } }
  };
  const chmod = async (it) => {
    const cur = (it.mode & 0o777).toString(8).padStart(3, '0');
    const n = await promptText('Permisos', `Permisos en octal para «${it.name}» (actual ${it.perms})`, cur);
    if (n && /^[0-7]{3,4}$/.test(n)) { try { await api('sftp:chmod', id, it.path, n); reload(); } catch (e) { toast(e.message, 'error'); } }
  };
  const open = async (it) => {
    if (it.isDir) return sftpLoad(id, it.path);
    if (it.isLink) {
      try { const info = await api('sftp:stat', id, it.path); if (info.isDir) return sftpLoad(id, it.path); } catch { /* enlace roto */ }
    }
    editRemoteFile(id, it.path);
  };

  const q = (st.filter || '').toLowerCase();
  const visible = (st.entries || []).filter((e) => (S().sftpHidden || !e.name.startsWith('.')) && (!q || e.name.toLowerCase().includes(q)));
  const list = h('div', { class: 'sftp-list', tabindex: '0' },
    st.cwd && st.cwd !== '/' && h('div', { class: 'frow', ondblclick: () => sftpLoad(id, parentPath(st.cwd)) }, icon('arrowUp', 15, 'dir'), h('span', { class: 'fname' }, '..'), h('span')),
    st.error && !st.entries ? h('div', { class: 'empty' }, icon('alert', 24), st.error) : null,
    visible.map((e) => {
      const it = { ...e, path: joinPath(st.cwd, e.name) };
      return h('div', {
        class: 'frow' + (st.sel.has(e.name) ? ' sel' : ''), title: `${e.name}\n${e.perms}  ${fmtSize(e.size)}  ${fmtDate(e.mtime)}`, draggable: 'false',
        onclick: (ev) => {
          if (ev.ctrlKey) { st.sel.has(e.name) ? st.sel.delete(e.name) : st.sel.add(e.name); }
          else if (ev.shiftKey && st.lastSel) {
            const names = visible.map((v) => v.name);
            const [a, b] = [names.indexOf(st.lastSel), names.indexOf(e.name)].sort((x, y) => x - y);
            names.slice(a, b + 1).forEach((n) => st.sel.add(n));
          } else { st.sel = new Set([e.name]); }
          st.lastSel = e.name;
          rerender();
        },
        ondblclick: () => open(it),
        oncontextmenu: (ev) => {
          ev.preventDefault();
          if (!st.sel.has(e.name)) { st.sel = new Set([e.name]); rerender(); }
          const sel = selected();
          showMenu(ev.clientX, ev.clientY, [
            !e.isDir && { label: 'Editar en ReaXTerm', icon: 'edit', action: () => editRemoteFile(id, it.path) },
            !e.isDir && { label: 'Abrir con editor externo', icon: 'export', action: async () => { try { await api('sftp:openExternal', id, it.path); toast('Abierto. Al guardar, los cambios se suben solos.', 'info', 5000); } catch (er) { toast(er.message, 'error'); } } },
            e.isDir && { label: 'Abrir carpeta', icon: 'folder', action: () => sftpLoad(id, it.path) },
            { label: sel.length > 1 ? `Descargar ${sel.length} elementos` : 'Descargar…', icon: 'download', action: () => download(sel) },
            { sep: true },
            { label: 'Renombrar…', icon: 'edit', disabled: sel.length > 1, action: () => rename(it) },
            { label: 'Permisos (chmod)…', icon: 'lock', disabled: sel.length > 1, action: () => chmod(it) },
            { label: 'Copiar ruta', icon: 'copy', action: () => api('clip:write', it.path) },
            t.session.type === 'ssh' && { label: 'Ir a esta ruta en la terminal', icon: 'terminal', action: () => { rx.write(id, `cd ${shQuote(e.isDir ? it.path : st.cwd)}\r`); tabs.get(id).term.focus(); } },
            { sep: true },
            { label: sel.length > 1 ? `Eliminar ${sel.length} elementos` : 'Eliminar', icon: 'trash', danger: true, action: () => remove(sel) },
          ]);
        },
      },
      icon(e.isDir ? 'folder' : e.isLink ? 'link' : 'file', 15, e.isDir ? 'dir' : e.isLink ? 'lnk' : 'f'),
      h('span', { class: 'fname' }, e.name),
      h('span', { class: 'fsize' }, e.isDir ? '' : fmtSize(e.size)));
    }));
  list.addEventListener('keydown', (e) => {
    if (e.key === 'Delete') remove(selected());
    if (e.key === 'F2' && selected().length === 1) rename(selected()[0]);
    if (e.key === 'Backspace') sftpLoad(id, parentPath(st.cwd));
    if (e.key === 'Enter' && selected().length === 1) open(selected()[0]);
    if (e.key === 'F5') { e.preventDefault(); reload(); }
    if (e.ctrlKey && e.code === 'KeyA') { e.preventDefault(); st.sel = new Set(visible.map((v) => v.name)); rerender(); }
  });
  let depth = 0;
  list.addEventListener('dragenter', (e) => { if (e.dataTransfer.types.includes('Files')) { depth++; list.classList.add('drop'); } });
  list.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; list.classList.remove('drop'); } });
  list.addEventListener('dragover', (e) => e.preventDefault());
  list.addEventListener('drop', (e) => {
    e.preventDefault(); depth = 0; list.classList.remove('drop');
    const files = [...e.dataTransfer.files].map((f) => rx.pathForFile(f)).filter(Boolean);
    if (files.length) uploadFiles(id, st.cwd, files);
  });

  const transfersBox = h('div', { class: 'transfers', id: 'transfers' });
  setTimeout(renderTransfers, 0);
  return [
    sideHead(title, st.loading ? h('span', { class: 'hint', style: { fontSize: '11px', color: 'var(--text-3)' } }, 'cargando…') : null),
    h('div', { class: 'sftp-path' }, pathInput),
    h('div', { class: 'sftp-bar' },
      h('button', { class: 'icon-btn sm', title: 'Subir un nivel (Retroceso)', onclick: () => sftpLoad(id, parentPath(st.cwd)) }, icon('arrowUp', 15)),
      h('button', { class: 'icon-btn sm', title: 'Carpeta personal', onclick: () => sftpLoad(id, '.') }, icon('home', 15)),
      h('button', { class: 'icon-btn sm', title: 'Actualizar (F5)', onclick: reload }, icon('refresh', 15)),
      h('button', { class: 'icon-btn sm', title: 'Subir archivos', onclick: () => uploadFiles(id, st.cwd) }, icon('upload', 15)),
      h('button', { class: 'icon-btn sm', title: 'Descargar selección', onclick: () => { const s = selected(); if (s.length) download(s); else toast('Selecciona uno o más elementos', 'info'); } }, icon('download', 15)),
      h('button', { class: 'icon-btn sm', title: 'Nueva carpeta', onclick: newFolder }, icon('folderPlus', 15)),
      h('button', { class: 'icon-btn sm', title: 'Nuevo archivo', onclick: newFile }, icon('filePlus', 15)),
      h('button', { class: 'icon-btn sm', title: 'Eliminar selección (Supr)', onclick: () => remove(selected()) }, icon('trash', 15)),
      h('button', { class: 'icon-btn sm' + (S().sftpHidden ? ' on' : ''), title: 'Mostrar archivos ocultos', onclick: () => { S().sftpHidden = !S().sftpHidden; save('settings'); rerender(); } }, icon('eye', 15)),
      t.session.type === 'ssh' && h('button', { class: 'icon-btn sm' + (S().sftpFollow ? ' on' : ''), title: `Seguir a la terminal: ${S().sftpFollow ? 'activado' : 'desactivado'}. El explorador abre el directorio del shell cada vez que cambia.`, onclick: () => toggleFollow(id) }, icon('terminal', 15))),
    h('div', { class: 'side-search', style: { margin: '0 10px 6px' } }, icon('search', 14), filterInput),
    list,
    h('div', { style: { padding: '4px 12px', fontSize: '11px', color: 'var(--text-3)' } }, `${visible.length} elementos · arrastra archivos aquí para subirlos`),
    transfersBox,
  ];
}

async function editRemoteFile(tabId, path) {
  let content;
  try { content = await api('sftp:readFile', tabId, path); } catch (e) { return toast(e.message, 'error'); }
  const area = h('textarea', { class: 'editor-area', spellcheck: 'false' });
  area.value = content;
  let dirty = false;
  const status = h('span', { style: { color: 'var(--text-3)', fontSize: '12px', marginRight: 'auto' } }, path);
  area.addEventListener('input', () => { if (!dirty) { dirty = true; status.textContent = '● ' + path; } });
  area.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') { e.preventDefault(); const s = area.selectionStart; area.setRangeText('\t', s, area.selectionEnd, 'end'); dirty = true; }
    if (e.ctrlKey && e.code === 'KeyS') { e.preventDefault(); doSave(); }
  });
  const doSave = async () => {
    try { await api('sftp:writeFile', tabId, path, area.value); dirty = false; status.textContent = '✓ Guardado — ' + path; toast('Archivo guardado', 'ok', 1600); } catch (e) { toast(e.message, 'error'); }
    return false;
  };
  const m = modal({
    title: path.split('/').pop(), iconName: 'edit', width: Math.min(1100, innerWidth - 80), body: h('div', {}, area, h('div', { style: { marginTop: '8px', display: 'flex' } }, status)),
    actions: [
      { label: 'Cerrar', ghost: true, onClick: async () => { if (dirty && !(await confirmBox('Cambios sin guardar', '¿Descartar los cambios?', { okLabel: 'Descartar', danger: true }))) return false; return true; } },
      { label: 'Guardar (Ctrl+S)', primary: true, icon: 'check', onClick: doSave },
    ],
  });
  m.box.setAttribute('data-noenter', '');
  setTimeout(() => area.focus(), 50);
}

// ------------------------------------------------------------ panel: túneles
rx.on('tunnel:status', (id, state, text) => {
  tunnelState[id] = { state, text };
  if (state === 'error') { const t = D.tunnels.find((x) => x.id === id); toast(`Túnel «${t ? t.name : id}»: ${text}`, 'error'); }
  renderAll();
});

async function startTunnel(t) {
  const s = D.sessions.find((x) => x.id === t.sessionId);
  if (!s) return toast('La sesión SSH del túnel ya no existe', 'error');
  try { await api('tunnel:start', t, s); toast(`Túnel «${t.name}» activo`, 'ok'); } catch (e) { /* el estado ya informa del error */ }
}

function tunnelsPanel() {
  const body = h('div', { class: 'side-body' });
  if (!D.tunnels.length) {
    body.append(h('div', { class: 'empty' }, icon('tunnel', 30),
      'Crea túneles SSH para acceder a bases de datos, paneles web o navegar a través de un servidor (SOCKS5).',
      h('button', { class: 'btn primary sm', onclick: () => editTunnel() }, icon('plus', 14), 'Nuevo túnel')));
  }
  const kinds = { local: 'LOCAL', remote: 'REMOTO', dynamic: 'SOCKS5' };
  for (const t of D.tunnels) {
    const st = tunnelState[t.id] || { state: 'stopped', text: 'Detenido' };
    const s = D.sessions.find((x) => x.id === t.sessionId);
    const running = st.state === 'running' || st.state === 'connecting';
    const desc = t.kind === 'dynamic' ? `localhost:${t.listenPort} (SOCKS5)` : t.kind === 'remote' ? `servidor:${t.listenPort} → ${t.destHost}:${t.destPort}` : `localhost:${t.listenPort} → ${t.destHost}:${t.destPort}`;
    body.append(h('div', { class: 'item-card' },
      h('div', { class: 'top' }, h('span', { class: 'dot ' + st.state }), h('span', { class: 'name' }, t.name), h('span', { class: 'chip' }, kinds[t.kind]),
        h('div', { class: 'acts' },
          h('button', { class: 'icon-btn sm', title: running ? 'Detener' : 'Iniciar', onclick: () => (running ? api('tunnel:stop', t.id) : startTunnel(t)) }, icon(running ? 'stop' : 'play', 14)),
          h('button', { class: 'icon-btn sm', title: 'Editar', onclick: () => editTunnel(t) }, icon('edit', 14)))),
      h('div', { class: 'desc' }, desc),
      h('div', { class: 'desc' }, `vía ${s ? s.name || s.host : '¿sesión eliminada?'} · ${st.text}`)));
  }
  return [sideHead('Túneles SSH', h('button', { class: 'icon-btn sm', title: 'Nuevo túnel', onclick: () => editTunnel() }, icon('plus', 16))), body];
}

function editTunnel(existing) {
  const isNew = !existing || !existing.id;
  const t = { kind: 'local', listenPort: '', destHost: '127.0.0.1', destPort: '', bindAll: false, autoStart: false, ...(existing || {}) };
  const sshSessions = D.sessions.filter((s) => s.type === 'ssh');
  if (!sshSessions.length) return toast('Primero crea una sesión SSH para usarla como pasarela', 'warn');
  if (!t.sessionId) t.sessionId = sshSessions[0].id;
  const body = h('div', {});
  const inp = (key, attrs) => { const el = h('input', { class: 'input', value: t[key] ?? '', spellcheck: 'false', ...attrs }); el.addEventListener('input', () => { t[key] = el.value; }); return el; };
  const field = (label, el, hint) => h('div', { class: 'field' }, h('label', {}, label), el, hint && h('div', { class: 'hint' }, hint));
  const render = () => {
    const sel = h('select', { class: 'select' }, sshSessions.map((s) => h('option', { value: s.id }, `${s.name || s.host} (${s.user ? s.user + '@' : ''}${s.host})`)));
    sel.value = t.sessionId;
    sel.addEventListener('change', () => { t.sessionId = sel.value; });
    const help = {
      local: 'Escucha en tu PC y reenvía a través del servidor SSH. Ej.: puerto 5433 → 127.0.0.1:5432 para PostgreSQL remoto.',
      remote: 'Escucha en el servidor SSH y reenvía hacia un destino accesible desde tu PC.',
      dynamic: 'Proxy SOCKS5 en tu PC: configura tu navegador con localhost:PUERTO para salir a internet desde el servidor.',
    };
    body.replaceChildren(
      field('Nombre', inp('name', { placeholder: 'p. ej. Base de datos producción', autofocus: true })),
      field('Pasarela SSH', sel),
      field('Tipo', h('div', { class: 'pills' }, [['local', 'Local (-L)'], ['remote', 'Remoto (-R)'], ['dynamic', 'Dinámico SOCKS (-D)']].map(([k, l]) =>
        h('button', { class: t.kind === k ? 'on' : '', onclick: () => { t.kind = k; render(); } }, l))), help[t.kind]),
      h('div', { class: 'grid3' },
        t.kind !== 'dynamic' ? field(t.kind === 'local' ? 'Host destino (visto desde el servidor)' : 'Host destino (visto desde tu PC)', inp('destHost')) : h('div'),
        field(t.kind === 'remote' ? 'Puerto en el servidor' : 'Puerto local', inp('listenPort', { type: 'number', min: 1, max: 65535 }))),
      t.kind !== 'dynamic' && field('Puerto destino', inp('destPort', { type: 'number', min: 1, max: 65535 })),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: t.bindAll, onchange: (e) => { t.bindAll = e.target.checked; } }), 'Permitir conexiones desde otros equipos (escuchar en 0.0.0.0)'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: t.autoStart, onchange: (e) => { t.autoStart = e.target.checked; } }), 'Iniciar automáticamente al abrir ReaXTerm'));
  };
  render();
  const persistTunnel = () => {
    if (!t.listenPort || (t.kind !== 'dynamic' && (!t.destHost || !t.destPort))) throw new Error('Completa los puertos y el destino');
    t.name = t.name || `${t.kind === 'dynamic' ? 'SOCKS' : t.destHost + ':' + t.destPort} (${t.listenPort})`;
    if (isNew) { t.id = uid(); D.tunnels.push(t); } else { const i = D.tunnels.findIndex((x) => x.id === t.id); D.tunnels[i] = t; }
    save('tunnels');
    renderAll();
  };
  modal({
    title: isNew ? 'Nuevo túnel SSH' : 'Editar túnel', iconName: 'tunnel', width: 560, body,
    actions: [
      !isNew && { label: 'Eliminar', icon: 'trash', ghost: true, left: true, onClick: async () => {
        await api('tunnel:stop', t.id); D.tunnels = D.tunnels.filter((x) => x.id !== t.id); delete tunnelState[t.id]; save('tunnels'); renderAll();
      } },
      { label: 'Cancelar', ghost: true },
      { label: 'Guardar', onClick: persistTunnel },
      { label: 'Guardar e iniciar', primary: true, icon: 'play', onClick: async () => { persistTunnel(); await api('tunnel:stop', t.id); startTunnel(t); } },
    ].filter(Boolean),
  });
}

// ------------------------------------------------------------ panel: comandos guardados
let snippetFilter = '';
function sendSnippet(sn) {
  const t = tabs.get(activeId);
  if (!t || t.state !== 'connected') return toast('No hay ninguna terminal conectada activa', 'warn');
  const text = sn.command.replace(/\r?\n/g, '\r') + (sn.enter ? '\r' : '');
  const targets = multiExec ? [...tabs.values()].filter((x) => x.state === 'connected' && x.multi) : [t];
  for (const x of targets) rx.write(x.id, text);
  t.term.focus();
}

function snippetsPanel() {
  const q = snippetFilter.toLowerCase();
  const list = D.snippets.filter((s) => !q || s.name.toLowerCase().includes(q) || s.command.toLowerCase().includes(q));
  const search = h('input', { placeholder: 'Buscar comandos…', value: snippetFilter, 'data-key': 'snipfilter', spellcheck: 'false' });
  search.addEventListener('input', () => { snippetFilter = search.value; renderSide(); });
  const body = h('div', { class: 'side-body' }, list.map((sn) => h('div', { class: 'item-card', ondblclick: () => sendSnippet(sn) },
    h('div', { class: 'top' }, icon('code', 14), h('span', { class: 'name' }, sn.name),
      h('div', { class: 'acts' },
        h('button', { class: 'icon-btn sm', title: multiExec ? 'Enviar a todas las pestañas' : 'Enviar a la terminal activa', onclick: () => sendSnippet(sn) }, icon('play', 14)),
        h('button', { class: 'icon-btn sm', title: 'Copiar', onclick: () => api('clip:write', sn.command).then(() => toast('Copiado', 'ok', 1200)) }, icon('copy', 14)),
        h('button', { class: 'icon-btn sm', title: 'Editar', onclick: () => editSnippet(sn) }, icon('edit', 14)))),
    h('div', { class: 'desc' }, sn.command.split('\n')[0]))),
  !list.length && h('div', { class: 'empty' }, icon('code', 28), 'Guarda los comandos que más usas y envíalos con un clic (también a varias pestañas a la vez con multi-ejecución).'));
  return [sideHead('Comandos guardados', h('button', { class: 'icon-btn sm', title: 'Nuevo comando', onclick: () => editSnippet() }, icon('plus', 16))),
    h('div', { class: 'side-search' }, icon('search', 14), search), body];
}

function editSnippet(existing) {
  const isNew = !existing || !existing.id;
  const sn = { name: '', command: '', enter: true, ...(existing || {}) };
  const name = h('input', { class: 'input', value: sn.name, autofocus: true, placeholder: 'p. ej. Reiniciar nginx' });
  const cmd = h('textarea', { class: 'textarea', placeholder: 'sudo systemctl restart nginx && systemctl status nginx --no-pager' }, sn.command);
  const enter = h('input', { type: 'checkbox', checked: sn.enter });
  modal({
    title: isNew ? 'Nuevo comando' : 'Editar comando', iconName: 'code', width: 540,
    body: h('div', { 'data-noenter': '' },
      h('div', { class: 'field' }, h('label', {}, 'Nombre'), name),
      h('div', { class: 'field' }, h('label', {}, 'Comando'), cmd, h('div', { class: 'hint' }, 'Puede tener varias líneas: cada una se envía como si la escribieras.')),
      h('label', { class: 'check' }, enter, 'Pulsar Enter al final (ejecutar)')),
    actions: [
      !isNew && { label: 'Eliminar', icon: 'trash', ghost: true, left: true, onClick: () => { D.snippets = D.snippets.filter((x) => x.id !== sn.id); save('snippets'); renderAll(); } },
      { label: 'Cancelar', ghost: true },
      { label: 'Guardar', primary: true, onClick: () => {
        if (!cmd.value.trim()) throw new Error('Escribe el comando');
        Object.assign(sn, { name: name.value.trim() || cmd.value.trim().slice(0, 40), command: cmd.value, enter: enter.checked });
        if (isNew) { sn.id = uid(); D.snippets.push(sn); } else { const i = D.snippets.findIndex((x) => x.id === sn.id); D.snippets[i] = sn; }
        save('snippets'); renderAll();
      } },
    ].filter(Boolean),
  });
}

// ------------------------------------------------------------ panel: herramientas
const outputs = {};
rx.on('tools:output', (runId, chunk) => {
  const el = outputs[runId];
  if (!el) return;
  if (chunk == null) { el.dataset.done = '1'; return; }
  el.textContent += chunk.replace(/\r/g, '');
  el.scrollTop = el.scrollHeight;
});

function toolCard(ic, title, build, openByDefault = false) {
  const card = h('div', { class: 'tool' + (openByDefault ? ' open' : '') });
  card.append(h('div', { class: 'tool-head', onclick: () => card.classList.toggle('open') }, icon(ic, 16), title, icon('chevron', 14, 'chev')), h('div', { class: 'tool-body' }, build()));
  return card;
}

const COMMON_PORTS = [21, 22, 23, 25, 53, 80, 110, 135, 139, 143, 389, 443, 445, 465, 587, 636, 993, 995, 1433, 1521, 2049, 2375, 3000, 3306, 3389, 5000, 5432, 5672, 5900, 5985, 6379, 8000, 8080, 8443, 8888, 9000, 9090, 9200, 11211, 27017];

function toolsPanel() {
  const inner = $('#sideInner');
  if (inner.dataset.panel === 'tools') return [];
  const runCmd = (channel) => () => {
    const host = h('input', { class: 'input', placeholder: 'host o IP', spellcheck: 'false' });
    const out = h('pre', { class: 'out' });
    const go = async () => {
      if (!host.value.trim()) return;
      const runId = uid();
      outputs[runId] = out;
      out.textContent = '';
      try { await api(channel, runId, host.value.trim()); } catch (e) { out.textContent = e.message; }
    };
    host.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    return [h('div', { class: 'row-inline' }, host, h('button', { class: 'btn primary', onclick: go }, icon('play', 13), 'Ejecutar')), out];
  };
  return [
    sideHead('Herramientas'),
    h('div', { class: 'side-body' },
      toolCard('activity', 'Ping', runCmd('tools:ping'), true),
      toolCard('globe', 'Traza de ruta (tracert)', runCmd('tools:trace')),
      toolCard('plug', 'Comprobar puerto TCP', () => {
        const host = h('input', { class: 'input', placeholder: 'host', spellcheck: 'false' });
        const port = h('input', { class: 'input', placeholder: 'puerto', type: 'number', style: { width: '90px' } });
        const out = h('pre', { class: 'out' });
        const go = async () => {
          try { const r = await api('tools:port', host.value.trim(), port.value); out.textContent = `${host.value}:${r.port} → ${r.open ? `ABIERTO (${r.ms} ms)` : 'cerrado o filtrado'}\n` + out.textContent; } catch (e) { out.textContent = e.message; }
        };
        port.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
        return [h('div', { class: 'row-inline' }, host, port), h('button', { class: 'btn primary sm', onclick: go, style: { marginBottom: '8px' } }, 'Comprobar'), out];
      }),
      toolCard('search', 'Escáner de puertos', () => {
        const host = h('input', { class: 'input', placeholder: 'host o IP', spellcheck: 'false' });
        const range = h('input', { class: 'input', placeholder: 'comunes  ·  o 1-1024  ·  22,80,443', spellcheck: 'false' });
        const out = h('pre', { class: 'out' });
        const go = async () => {
          let ports = COMMON_PORTS;
          const r = range.value.trim();
          if (r) {
            ports = [];
            for (const part of r.split(',')) {
              const [a, b] = part.split('-').map((x) => parseInt(x, 10));
              if (a && b) for (let p = a; p <= Math.min(b, 65535); p++) ports.push(p); else if (a) ports.push(a);
            }
          }
          if (ports.length > 5000) return toast('Máximo 5000 puertos por escaneo', 'warn');
          const runId = uid();
          out.textContent = `Escaneando ${ports.length} puertos…`;
          const off = rx.on('tools:scan-progress', (id, done, total, open) => { if (id === runId) out.textContent = `Progreso ${done}/${total}\nAbiertos: ${open.join(', ') || '—'}`; });
          try { const open = await api('tools:scan', runId, host.value.trim(), ports); out.textContent = `Completado: ${ports.length} puertos analizados\nAbiertos: ${open.join(', ') || 'ninguno'}`; } catch (e) { out.textContent = e.message; } finally { off(); }
        };
        return [h('div', { class: 'row-inline' }, host), h('div', { class: 'row-inline' }, range, h('button', { class: 'btn primary', onclick: go }, 'Escanear')), out,
          h('div', { class: 'hint', style: { fontSize: '11px', color: 'var(--text-3)', marginTop: '6px' } }, 'Úsalo sólo en equipos que administras.')];
      }),
      toolCard('globe', 'Consulta DNS', () => {
        const host = h('input', { class: 'input', placeholder: 'dominio o IP', spellcheck: 'false' });
        const out = h('pre', { class: 'out' });
        const go = async () => {
          const r = await api('tools:dns', host.value.trim()).catch((e) => ({ error: e.message }));
          out.textContent = r.error ? r.error : `Direcciones:\n  ${r.addresses.join('\n  ') || '—'}${r.reverse.length ? `\nInverso (PTR):\n  ${r.reverse.join('\n  ')}` : ''}`;
        };
        host.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
        return [h('div', { class: 'row-inline' }, host, h('button', { class: 'btn primary', onclick: go }, 'Buscar')), out];
      }),
      toolCard('key', 'Generador de claves SSH', () => {
        const type = h('select', { class: 'select' }, h('option', { value: 'ed25519' }, 'Ed25519 (recomendada)'), h('option', { value: 'ecdsa' }, 'ECDSA'), h('option', { value: 'rsa' }, 'RSA 4096'));
        const comment = h('input', { class: 'input', placeholder: 'comentario (p. ej. tu correo)' });
        const pass = h('input', { class: 'input', type: 'password', placeholder: 'frase de paso (opcional)' });
        const out = h('pre', { class: 'out' });
        const go = async () => {
          try {
            const r = await api('tools:keygen', type.value, comment.value, pass.value);
            out.textContent = (r.privatePath ? `Guardada en:\n${r.privatePath}\n${r.privatePath}.pub\n\n` : '') + 'Clave pública (añádela a ~/.ssh/authorized_keys):\n' + r.publicKey;
            await api('clip:write', r.publicKey);
            toast('Clave pública copiada al portapapeles', 'ok');
          } catch (e) { out.textContent = e.message; }
        };
        return [h('div', { class: 'row-inline' }, type), h('div', { class: 'row-inline' }, comment), h('div', { class: 'row-inline' }, pass),
          h('button', { class: 'btn primary sm', onclick: go, style: { marginBottom: '8px' } }, icon('key', 13), 'Generar'), out];
      }),
      toolCard('lock', 'Generador de contraseñas', () => {
        const len = h('input', { class: 'input', type: 'number', value: 20, min: 8, max: 128, style: { width: '80px' } });
        const sym = h('input', { type: 'checkbox', checked: true });
        const out = h('pre', { class: 'out' });
        const go = () => {
          const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789' + (sym.checked ? '!@#$%&*-_=+?' : '');
          const arr = new Uint32Array(Number(len.value) || 20);
          crypto.getRandomValues(arr);
          const pw = [...arr].map((n) => chars[n % chars.length]).join('');
          out.textContent = pw;
          api('clip:write', pw);
          toast('Contraseña copiada', 'ok', 1500);
        };
        return [h('div', { class: 'row-inline', style: { alignItems: 'center' } }, len, h('label', { class: 'check', style: { margin: 0 } }, sym, 'Símbolos'), h('button', { class: 'btn primary sm', onclick: go }, 'Generar')), out];
      }),
      toolCard('wifi', 'Información de red local', () => {
        const out = h('pre', { class: 'out' });
        const go = async () => {
          const r = await api('tools:netinfo');
          out.textContent = `Equipo: ${r.hostname}\nUsuario: ${r.user}\nSistema: ${r.platform}\n\n` + r.ifaces.map((i) => `${i.name}\n  ${i.cidr || i.address}  (${i.family})\n  MAC ${i.mac}`).join('\n');
        };
        return [h('button', { class: 'btn primary sm', onclick: go, style: { marginBottom: '8px' } }, 'Mostrar'), out];
      }),
      toolCard('shield', 'Servidores conocidos (huellas)', () => {
        const box = h('div', {});
        const load = async () => {
          const kh = await api('store:knownHosts');
          const entries = Object.entries(kh);
          box.replaceChildren(...(entries.length ? entries.map(([host, fp]) => h('div', { class: 'item-card' },
            h('div', { class: 'top' }, h('span', { class: 'name' }, host), h('button', { class: 'icon-btn sm', title: 'Olvidar', onclick: async () => { await api('store:forgetHost', host); load(); } }, icon('trash', 13))),
            h('div', { class: 'desc' }, fp))) : [h('div', { class: 'hint', style: { color: 'var(--text-3)' } }, 'Aún no hay servidores registrados.')]));
        };
        return [h('button', { class: 'btn sm', onclick: load, style: { marginBottom: '8px' } }, icon('refresh', 13), 'Cargar lista'), box];
      })),
  ];
}

// ============================================================ conexión rápida
function parseQuick(str) {
  let s = str.trim();
  let type = 'ssh';
  const m = s.match(/^(ssh|telnet|rdp)\s+(.+)$/i);
  if (m) { type = m[1].toLowerCase(); s = m[2]; }
  let port = '';
  const pm = s.match(/\s+-p\s*(\d+)/);
  if (pm) { port = Number(pm[1]); s = s.replace(pm[0], ''); }
  const parts = s.trim().split(/\s+/);
  s = parts[0];
  if (!port && parts[1] && /^\d+$/.test(parts[1])) port = Number(parts[1]);
  let user = '';
  const at = s.lastIndexOf('@');
  if (at > 0) { user = s.slice(0, at); s = s.slice(at + 1); }
  let host = s;
  const hp = s.match(/^\[(.+)\](?::(\d+))?$/) || (s.split(':').length === 2 ? s.match(/^([^:]+):(\d+)$/) : null);
  if (hp) { host = hp[1]; if (hp[2]) port = Number(hp[2]); }
  if (!host) return null;
  return { type, host, port, user, auth: 'password', keepalive: 30 };
}

let quickSel = 0;
function quickMatches(q) {
  q = q.toLowerCase();
  if (!q) return D.recent.map((id) => D.sessions.find((s) => s.id === id)).filter(Boolean).slice(0, 6);
  return D.sessions.filter((s) => [s.name, s.host, s.user, s.folder].some((v) => v && String(v).toLowerCase().includes(q))).slice(0, 7);
}
function renderQuick() {
  const input = $('#quickInput');
  const list = $('#quickList');
  const q = input.value.trim();
  const matches = quickMatches(q);
  const items = matches.map((s) => ({ s, label: s.name || s.host, sub: `${s.user ? s.user + '@' : ''}${s.host || TYPES[s.type].label}`, ic: TYPES[s.type].icon }));
  const parsed = q && parseQuick(q);
  if (parsed) items.push({ quick: parsed, label: `Conectar: ${parsed.type.toUpperCase()} ${parsed.user ? parsed.user + '@' : ''}${parsed.host}${parsed.port ? ':' + parsed.port : ''}`, sub: 'Enter', ic: 'zap' });
  quickSel = Math.min(quickSel, Math.max(0, items.length - 1));
  list.replaceChildren(...items.map((it, i) => h('div', {
    class: 'pal-item' + (i === quickSel ? ' sel' : ''), onmousedown: (e) => { e.preventDefault(); runQuick(it); },
  }, icon(it.ic, 15), it.label, h('span', { class: 'sub' }, it.sub))));
  list.classList.toggle('open', document.activeElement === input && items.length > 0);
  list._items = items;
}
function runQuick(it) {
  const input = $('#quickInput');
  input.value = '';
  input.blur();
  $('#quickList').classList.remove('open');
  if (it.s) openSession(it.s);
  else if (it.quick) openSession(it.quick);
}
(() => {
  const input = $('#quickInput');
  $('#quickIcon').append(icon('zap', 14));
  input.addEventListener('input', () => { quickSel = 0; renderQuick(); });
  input.addEventListener('focus', renderQuick);
  input.addEventListener('blur', () => setTimeout(() => $('#quickList').classList.remove('open'), 120));
  input.addEventListener('keydown', (e) => {
    const items = $('#quickList')._items || [];
    if (e.key === 'ArrowDown') { e.preventDefault(); quickSel = Math.min(items.length - 1, quickSel + 1); renderQuick(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); quickSel = Math.max(0, quickSel - 1); renderQuick(); }
    if (e.key === 'Enter') {
      e.preventDefault();
      const parsed = input.value.trim() && parseQuick(input.value);
      const pick = items[quickSel] || (parsed && { quick: parsed });
      if (pick) runQuick(pick);
    }
    if (e.key === 'Escape') { input.value = ''; input.blur(); const t = tabs.get(activeId); if (t) t.term.focus(); }
  });
})();

// ============================================================ paleta de comandos
function paletteCommands() {
  const cmds = [
    ['Nueva sesión…', 'plus', () => editSession(), 'Ctrl+Shift+N'],
    ...INFO.shells.map((s) => [`Abrir ${s.label}`, 'terminal', () => newLocal(s.id), '']),
    [multiExec ? 'Desactivar multi-ejecución' : 'Activar multi-ejecución', 'broadcast', toggleMulti, 'Ctrl+Shift+M'],
    [layout === 'grid' ? 'Vista en pestañas' : 'Vista en mosaico', 'grid', toggleLayout, 'Ctrl+Shift+L'],
    ['Mostrar/ocultar panel lateral', 'sidebar', toggleSidebar, 'Ctrl+Shift+B'],
    ['Credenciales', 'key', () => setPanel('credentials'), ''],
    ['Nueva credencial…', 'key', () => editCredential(), ''],
    ['Explorador SFTP', 'folder', () => setPanel('sftp'), ''],
    ['Túneles SSH', 'tunnel', () => setPanel('tunnels'), ''],
    ['Nuevo túnel…', 'tunnel', () => editTunnel(), ''],
    ['Nuevo comando guardado…', 'code', () => editSnippet(), ''],
    ['Herramientas de red', 'tool', () => setPanel('tools'), ''],
    ['Importar sesiones (MobaXterm, PuTTY, mRemoteNG, Excel, CSV, JSON)…', 'import', openImport, ''],
    ['Importar contraseñas de MobaXterm…', 'key', importMobaPasswords, ''],
    ['Exportar configuración completa (cifrada)…', 'export', exportBackup, ''],
    ['Importar configuración…', 'import', importBackup, ''],
    ['Ajustes', 'settings', () => openSettings(), ''],
    ['Pantalla completa', 'maximize', () => api('app:fullscreen'), 'F11'],
  ];
  const t = tabs.get(activeId);
  if (t) {
    cmds.push(['Buscar en la terminal', 'search', () => openSearch(t), 'Ctrl+Shift+F']);
    cmds.push(['Reconectar pestaña actual', 'refresh', () => reconnect(t), '']);
    cmds.push([t.logging ? 'Detener registro' : 'Registrar sesión en archivo…', 'record', () => toggleLog(t), '']);
    cmds.push(['Cerrar pestaña actual', 'x', () => closeTab(t.id), 'Ctrl+Shift+W']);
  }
  return cmds.map(([label, ic, run, hint]) => ({ kind: 'Comando', label, ic, run, sub: hint }))
    .concat(D.sessions.map((s) => ({ kind: 'Sesión', label: s.name || s.host, ic: TYPES[s.type].icon, sub: s.host || '', run: () => openSession(s), extra: `${s.host} ${s.user} ${s.folder}` })))
    .concat(D.snippets.map((sn) => ({ kind: 'Comando', label: '▶ ' + sn.name, ic: 'code', sub: sn.command.slice(0, 40), run: () => sendSnippet(sn), extra: sn.command })))
    .concat([...tabs.values()].map((x) => ({ kind: 'Pestaña', label: tabTitle(x), ic: TYPES[x.session.type].icon, sub: x.statusText || '', run: () => activate(x.id) })));
}

function fuzzy(q, text) {
  q = q.toLowerCase(); text = text.toLowerCase();
  if (text.includes(q)) return 2;
  let i = 0;
  for (const ch of text) if (ch === q[i]) i++;
  return i === q.length ? 1 : 0;
}

function openPalette() {
  if ($('.palette')) return;
  const all = paletteCommands();
  let sel = 0;
  let items = all;
  const input = h('input', { placeholder: 'Escribe un comando, sesión o pestaña…', spellcheck: 'false' });
  const list = h('div', { class: 'palette-list' });
  const wrap = h('div', { class: 'palette', onmousedown: (e) => { if (e.target === wrap) close(); } }, h('div', { class: 'palette-box' }, input, list));
  const close = () => { wrap.remove(); const t = tabs.get(activeId); if (t) t.term.focus(); };
  const render = () => {
    const q = input.value.trim();
    items = q ? all.map((it) => ({ it, sc: fuzzy(q, it.label + ' ' + (it.extra || '')) })).filter((x) => x.sc).sort((a, b) => b.sc - a.sc).map((x) => x.it) : all;
    sel = Math.min(sel, Math.max(0, items.length - 1));
    list.replaceChildren(...items.slice(0, 60).map((it, i) => h('div', { class: 'pal-item' + (i === sel ? ' sel' : ''), onclick: () => { close(); it.run(); } },
      h('span', { class: 'kind' }, it.kind), icon(it.ic, 15), it.label, h('span', { class: 'sub' }, it.sub || ''))));
    const s = list.querySelector('.sel');
    if (s) s.scrollIntoView({ block: 'nearest' });
  };
  input.addEventListener('input', () => { sel = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); render(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); render(); }
    if (e.key === 'Enter') { e.preventDefault(); const it = items[sel]; close(); if (it) it.run(); }
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  document.body.append(wrap);
  render();
  input.focus();
}

// ============================================================ ajustes
function openSettings(page = 'appearance') {
  const s = S();
  const body = h('div', { class: 'settings-wrap' });
  const nav = h('div', { class: 'settings-nav' });
  const content = h('div', { class: 'settings-page' });
  const changed = () => { save('settings'); applyTheme(); };
  const check = (key, label, after) => {
    const el = h('input', { type: 'checkbox', checked: !!s[key] });
    el.addEventListener('change', () => { s[key] = el.checked; changed(); if (after) after(); });
    return h('label', { class: 'check' }, el, label);
  };
  const field = (label, el, hint) => h('div', { class: 'field' }, h('label', {}, label), el, hint && h('div', { class: 'hint' }, hint));
  const pages = {
    appearance: ['Apariencia', 'palette', () => [
      h('h4', {}, 'Apariencia'),
      field('Tema de la aplicación', h('div', { class: 'pills' }, [['dark', 'Oscuro'], ['light', 'Claro'], ['system', 'Sistema']].map(([k, l]) =>
        h('button', { class: s.appTheme === k ? 'on' : '', onclick: () => { s.appTheme = k; changed(); show('appearance'); } }, l)))),
      field('Color de acento', h('div', { class: 'colors' }, ACCENTS.map((c) => h('button', {
        class: 'swatch' + (s.accent === c ? ' on' : ''), style: { background: c }, onclick: () => { s.accent = c; changed(); show('appearance'); },
      })))),
      field('Esquema de colores del terminal', h('div', { class: 'theme-grid' }, Object.entries(TERM_THEMES).map(([k, th]) => h('div', {
        class: 'theme-opt' + (s.termTheme === k ? ' on' : ''), onclick: () => { s.termTheme = k; changed(); show('appearance'); },
      }, h('div', { class: 'prev', style: { background: th.colors.background, color: th.colors.foreground } },
        h('span', { style: { color: th.colors.green } }, 'user@srv'), ':', h('span', { style: { color: th.colors.blue } }, '~'), '$ ls', h('br'),
        h('span', { style: { color: th.colors.cyan } }, 'docs '), h('span', { style: { color: th.colors.yellow } }, 'app.sh '), h('span', { style: { color: th.colors.red } }, 'err')),
      th.name)))),
    ]],
    terminal: ['Terminal', 'terminal', () => {
      const font = h('input', { class: 'input', value: s.fontFamily });
      font.addEventListener('change', () => { s.fontFamily = font.value; changed(); });
      const size = h('input', { class: 'input', type: 'number', min: 8, max: 32, value: s.fontSize });
      size.addEventListener('change', () => { s.fontSize = Number(size.value) || 14; changed(); });
      const lh = h('input', { class: 'input', type: 'number', min: 1, max: 2, step: 0.05, value: s.lineHeight });
      lh.addEventListener('change', () => { s.lineHeight = Number(lh.value) || 1.15; changed(); });
      const sb = h('input', { class: 'input', type: 'number', min: 1000, max: 200000, step: 1000, value: s.scrollback });
      sb.addEventListener('change', () => { s.scrollback = Number(sb.value) || 10000; changed(); });
      const cursor = h('div', { class: 'pills' }, [['bar', 'Barra │'], ['block', 'Bloque █'], ['underline', 'Subrayado _']].map(([k, l]) =>
        h('button', { class: s.cursorStyle === k ? 'on' : '', onclick: () => { s.cursorStyle = k; changed(); show('terminal'); } }, l)));
      return [h('h4', {}, 'Terminal'),
        field('Fuente', font, 'Ejemplos: Cascadia Mono, Consolas, JetBrains Mono, Fira Code'),
        h('div', { class: 'grid2' }, field('Tamaño', size), field('Interlineado', lh)),
        field('Cursor', cursor),
        field('Líneas de historial (scrollback)', sb),
        check('cursorBlink', 'Cursor parpadeante'),
        check('webgl', 'Aceleración por GPU (WebGL) — se aplica a pestañas nuevas')];
    }],
    behavior: ['Comportamiento', 'zap', () => {
      const shellSel = h('select', { class: 'select' }, INFO.shells.map((x) => h('option', { value: x.id }, x.label)));
      shellSel.value = s.defaultShell;
      shellSel.addEventListener('change', () => { s.defaultShell = shellSel.value; changed(); });
      const pw = h('input', { class: 'input', type: 'number', min: 0, max: 1000, value: s.pasteWarnLines });
      pw.addEventListener('change', () => { s.pasteWarnLines = Number(pw.value) || 0; changed(); });
      return [h('h4', {}, 'Comportamiento'),
        field('Terminal local predeterminado', shellSel),
        check('copyOnSelect', 'Copiar automáticamente al seleccionar texto'),
        check('rightClickPaste', 'Clic derecho pega (Ctrl + clic derecho abre el menú)'),
        check('confirmClose', 'Confirmar antes de cerrar pestañas conectadas'),
        check('autoSftp', 'Mostrar el explorador SFTP al conectar por SSH'),
        field('Avisar al pegar más de N líneas (0 = nunca)', pw),
        check('compactSessions', 'Vista compacta de sesiones (usuario y servidor al pasar el mouse)', renderSide)];
    }],
    credentials: ['Credenciales', 'key', () => {
      const refresh = () => { renderAll(); show('credentials'); };
      const filter = h('input', { class: 'input', style: { flex: '1', minWidth: '0' }, placeholder: 'Buscar por nombre o usuario…', value: credMgrFilter, spellcheck: 'false' });
      filter.addEventListener('input', () => { credMgrFilter = filter.value; drawList(); });
      const list = h('div', { class: 'cred-table' });
      const remove = async (c) => {
        const uses = credUses(c);
        const msg = uses ? `«${c.name}» la usan ${uses} sesiones, que volverán a pedir usuario y contraseña al conectar.` : `¿Eliminar la credencial «${c.name}»?`;
        if (!(await confirmBox('Eliminar credencial', msg, { okLabel: 'Eliminar', danger: true }))) return;
        D.credentials = D.credentials.filter((x) => x.id !== c.id);
        for (const x of D.sessions) if (x.credentialId === c.id) delete x.credentialId;
        save('credentials'); save('sessions'); refresh();
      };
      const drawList = () => {
        const q = credMgrFilter.toLowerCase();
        const items = D.credentials.filter((c) => !q || [c.name, c.user].some((v) => v && v.toLowerCase().includes(q)))
          .sort((a, b) => a.name.localeCompare(b.name, 'es'));
        list.replaceChildren(
          h('div', { class: 'cred-row head' }, h('span', {}, 'Nombre'), h('span', {}, 'Usuario'), h('span', {}, 'Contraseña'), h('span', {}, 'Sesiones'), h('span')),
          ...items.map((c) => h('div', { class: 'cred-row', ondblclick: () => editCredential(c, refresh) },
            h('span', { class: 'n' }, icon('key', 13), c.name),
            h('span', { class: 'u' }, c.user || '—'),
            h('span', { class: c.passwordEnc ? 'ok' : 'warn' }, c.passwordEnc ? 'Guardada' : 'Pendiente'),
            h('span', {}, String(credUses(c))),
            h('span', { class: 'acts' },
              h('button', { class: 'icon-btn sm', title: 'Editar', onclick: () => editCredential(c, refresh) }, icon('edit', 14)),
              h('button', { class: 'icon-btn sm', title: 'Copiar (crea una credencial nueva con los mismos datos)', onclick: () => editCredential({ ...c, id: undefined, name: c.name + ' (copia)' }, refresh) }, icon('copy', 14)),
              h('button', { class: 'icon-btn sm danger', title: 'Eliminar', onclick: () => remove(c) }, icon('trash', 14))))),
          ...(items.length ? [] : [h('div', { class: 'empty', style: { padding: '20px' } }, D.credentials.length ? 'Sin resultados' : 'Aún no tienes credenciales.')]));
      };
      drawList();
      return [h('h4', {}, 'Administrador de credenciales'),
        h('p', { class: 'hint' }, 'Usuario y contraseña reutilizables. Si editas una credencial, el cambio se aplica a todas las sesiones que la usan. Las contraseñas se guardan cifradas con DPAPI.'),
        h('div', { class: 'row-inline', style: { marginBottom: '10px' } }, filter,
          h('button', { class: 'btn primary', onclick: () => editCredential(null, refresh) }, icon('plus', 14), 'Nueva'),
          h('button', { class: 'btn', title: 'Importar contraseñas de MobaXterm', onclick: async () => { await importMobaPasswords(); show('credentials'); } }, icon('import', 14), 'Importar')),
        list];
    }],
    data: ['Datos y respaldo', 'shield', () => [h('h4', {}, 'Datos y respaldo'),
      h('p', {}, 'Tus sesiones, credenciales, comandos y túneles se guardan en tu perfil de Windows. Las contraseñas se cifran con DPAPI y sólo pueden leerse desde tu usuario en este equipo.'),
      h('p', {}, 'Para llevar todo a otro equipo usa «Exportar configuración»: crea un archivo .rxbackup con sesiones, credenciales y contraseñas, comandos, túneles, ajustes y servidores conocidos, cifrado (AES-256) con la contraseña que elijas.'),
      h('div', { class: 'fp', style: { marginBottom: '12px' } }, INFO.dataPath || ''),
      h('div', { class: 'row-inline', style: { flexWrap: 'wrap' } },
        h('button', { class: 'btn', onclick: () => api('app:openData') }, icon('folder', 14), 'Abrir carpeta'),
        h('button', { class: 'btn', onclick: exportBackup }, icon('export', 14), 'Exportar configuración'),
        h('button', { class: 'btn', onclick: importBackup }, icon('import', 14), 'Importar configuración'),
        h('button', { class: 'btn', onclick: openImport }, icon('import', 14), 'Importar sesiones'),
        h('button', { class: 'btn', onclick: importMobaPasswords }, icon('key', 14), 'Importar contraseñas de MobaXterm'))]],
    about: ['Acerca de', 'info', () => [h('div', { class: 'hero', style: { marginBottom: '16px' } }, h('img', { src: '../assets/logo.svg', alt: '' }),
      h('div', {}, h('h1', { style: { fontSize: '22px' } }, 'Rea', h('b', {}, 'X'), 'Term'), h('p', {}, `Versión ${INFO.version || '1.0.0'}`))),
      h('div', { class: 'fp' }, `Electron ${INFO.electron} · Node ${INFO.node} · ${INFO.platform}\nTerminal local: ${INFO.ptyAvailable ? 'disponible' : 'NO disponible (node-pty)'}`),
      h('p', { style: { marginTop: '12px' } }, 'Terminal moderno inspirado en las herramientas clásicas de administración de sistemas, con SSH, SFTP, FTP, Telnet, RDP, puerto serie, túneles, multi-ejecución y herramientas de red.')]],
  };
  const show = (p) => {
    page = p;
    nav.replaceChildren(...Object.entries(pages).map(([k, [label, ic]]) => h('button', { class: k === page ? 'on' : '', onclick: () => show(k) }, icon(ic, 15), label)));
    content.replaceChildren(...pages[page][2]());
  };
  body.append(nav, content);
  show(page);
  modal({ title: 'Ajustes', iconName: 'settings', width: 780, body, actions: [{ label: 'Restablecer valores', ghost: true, left: true, onClick: async () => {
    if (!(await confirmBox('Restablecer ajustes', '¿Volver a los ajustes predeterminados? Tus sesiones no se modifican.'))) return false;
    D.settings = { ...DEFAULT_SETTINGS }; changed(); renderAll(); return true;
  } }, { label: 'Listo', primary: true }] });
}

// ============================================================ atajos globales
function isGlobalShortcut(e) {
  return (e.ctrlKey && e.shiftKey && ['KeyT', 'KeyW', 'KeyN', 'KeyM', 'KeyL', 'KeyP', 'KeyB'].includes(e.code))
    || (e.ctrlKey && e.code === 'Tab')
    || (e.altKey && !e.ctrlKey && /^Digit[1-9]$/.test(e.code))
    || (e.ctrlKey && !e.shiftKey && ['Equal', 'Minus', 'Digit0', 'NumpadAdd', 'NumpadSubtract'].includes(e.code))
    || e.code === 'F11';
}

function zoom(delta) {
  S().fontSize = delta === 0 ? DEFAULT_SETTINGS.fontSize : Math.max(8, Math.min(32, S().fontSize + delta));
  save('settings');
  for (const t of tabs.values()) applyTermOptions(t);
  toast(`Tamaño de fuente: ${S().fontSize}px`, 'info', 1000);
}

document.addEventListener('keydown', (e) => {
  if ($('.backdrop') || $('.palette')) return;
  if (!isGlobalShortcut(e)) return;
  e.preventDefault();
  const c = e.code;
  if (e.ctrlKey && e.shiftKey) {
    if (c === 'KeyT') newLocal();
    else if (c === 'KeyW') { if (activeId) closeTab(activeId); }
    else if (c === 'KeyN') editSession();
    else if (c === 'KeyM') toggleMulti();
    else if (c === 'KeyL') toggleLayout();
    else if (c === 'KeyP') openPalette();
    else if (c === 'KeyB') toggleSidebar();
    else if (c === 'Tab') cycleTab(-1);
  } else if (e.ctrlKey && c === 'Tab') cycleTab(1);
  else if (e.altKey && /^Digit/.test(c)) { const id = order[Number(c.slice(5)) - 1]; if (id) activate(id); }
  else if (e.ctrlKey && (c === 'Equal' || c === 'NumpadAdd')) zoom(1);
  else if (e.ctrlKey && (c === 'Minus' || c === 'NumpadSubtract')) zoom(-1);
  else if (e.ctrlKey && c === 'Digit0') zoom(0);
  else if (c === 'F11') api('app:fullscreen');
});

document.addEventListener('wheel', (e) => {
  if (e.ctrlKey && e.target.closest('.pane-term')) { e.preventDefault(); zoom(e.deltaY < 0 ? 1 : -1); }
}, { passive: false });

// Cierre de la ventana con conexiones abiertas
rx.on('app:request-close', async (count) => {
  if (!S().confirmClose || await confirmBox('Salir de ReaXTerm', `Hay ${count} conexión(es) abierta(s). ¿Cerrarlas y salir?`, { okLabel: 'Salir', danger: true })) api('app:quit');
});

matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (S().appTheme === 'system') applyTheme(); });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// ============================================================ inicio
(async function init() {
  $('#tabAdd').append(icon('plus', 17));
  $('#tabAdd').addEventListener('click', () => newLocal());
  $('#tabAdd').addEventListener('contextmenu', (e) => { e.preventDefault(); shellMenu(e); });
  try { INFO = await api('app:info'); } catch (e) { console.error(e); }
  const stored = await api('store:all').catch(() => ({}));
  D.sessions = stored.sessions || [];
  D.credentials = stored.credentials || [];
  D.snippets = stored.snippets || DEFAULT_SNIPPETS;
  D.tunnels = stored.tunnels || [];
  D.recent = stored.recent || [];
  D.settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  if (!D.settings.openFolders) D.settings.openFolders = {};
  if (!INFO.shells.some((s) => s.id === D.settings.defaultShell) && INFO.shells[0]) D.settings.defaultShell = INFO.shells[0].id;
  if (!stored.snippets) save('snippets');
  applyTheme();
  renderAll();
  for (const t of D.tunnels.filter((x) => x.autoStart)) startTunnel(t);
  const running = await api('tunnel:list').catch(() => []);
  for (const id of running) tunnelState[id] = { state: 'running', text: 'Activo' };
  if (!INFO.ptyAvailable) toast('El terminal local no está disponible: ejecuta «npm install» en la carpeta de ReaXTerm.', 'warn', 8000);
})();
