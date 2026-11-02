'use strict';
// Captura de teclas del sistema para las pestañas RDP (Windows).
// Windows procesa la tecla Windows (y Win+letra, Ctrl+Esc, Alt+Tab) antes que cualquier aplicación,
// así que el navegador no puede evitar que se abra el menú Inicio local. Un hook de teclado de bajo nivel
// (WH_KEYBOARD_LL) en un proceso PowerShell auxiliar las intercepta sólo mientras ReaXTerm está en primer
// plano y el foco está en una sesión RDP, y se las pasa a la app para enviarlas al equipo remoto.
// El auxiliar no registra nada: sólo informa por stdout la tecla interceptada (código virtual) a este proceso.
const { spawn } = require('child_process');

const CS = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public static class RxKeyHook {
  delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] struct KBDLL { public uint vk, scan, flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint msg; public IntPtr w, l; public uint time; public int x, y; }
  [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, HookProc proc, IntPtr mod, uint thread);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
  [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr hwnd, uint min, uint max);
  [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);

  static volatile bool active;
  static IntPtr target, hook;
  static HookProc proc;
  static readonly HashSet<uint> held = new HashSet<uint>();
  static readonly object outLock = new object();

  static bool Down(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }

  static bool Grab(uint vk) {
    if (vk == 0x5B || vk == 0x5C) return true;                       // Windows
    if (held.Contains(0x5B) || held.Contains(0x5C)) return true;     // Win + otra tecla
    if (vk == 0x1B && (Down(0x11) || Down(0x12))) return true;       // Ctrl+Esc, Alt+Esc
    if (vk == 0x09 && Down(0x12)) return true;                       // Alt+Tab
    return false;
  }

  static void Emit(string kind, uint vk) {
    lock (outLock) { Console.Out.WriteLine(kind + " " + vk); Console.Out.Flush(); }
  }

  static IntPtr Callback(int code, IntPtr w, IntPtr l) {
    if (code >= 0) {
      KBDLL k = (KBDLL)Marshal.PtrToStructure(l, typeof(KBDLL));
      bool up = (k.flags & 0x80) != 0, injected = (k.flags & 0x10) != 0;
      if (!injected) {
        if (held.Contains(k.vk)) {
          if (up) held.Remove(k.vk);
          Emit(up ? "u" : "d", k.vk);
          return (IntPtr)1;
        }
        if (!up && active && GetForegroundWindow() == target && Grab(k.vk)) {
          held.Add(k.vk);
          Emit("d", k.vk);
          return (IntPtr)1;
        }
      }
    }
    return CallNextHookEx(hook, code, w, l);
  }

  public static void Run(long hwnd) {
    target = new IntPtr(hwnd);
    new Thread(() => {
      string line;
      while ((line = Console.In.ReadLine()) != null) active = line.Trim() == "1";
      Environment.Exit(0); // la app se cerró
    }) { IsBackground = true }.Start();
    proc = Callback;
    hook = SetWindowsHookEx(13, proc, GetModuleHandle(Process.GetCurrentProcess().MainModule.ModuleName), 0);
    if (hook == IntPtr.Zero) { Console.Out.WriteLine("error hook"); Console.Out.Flush(); return; }
    Console.Out.WriteLine("ready"); Console.Out.Flush();
    MSG m;
    while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) { }
  }
}
`;

function createKeyHook({ hwnd, onKey, log = () => {} }) {
  let child = null;
  let failed = false;
  let want = false;

  function start() {
    if (child || failed || process.platform !== 'win32') return;
    const script = `$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition @'\n${CS}\n'@\n[RxKeyHook]::Run(${hwnd()})\n`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        const m = line.match(/^([du]) (\d+)$/);
        if (m) onKey(m[1] === 'd' ? 'keydown' : 'keyup', Number(m[2]));
        else if (line === 'ready') { log('teclas: captura lista'); child.stdin.write(want ? '1\n' : '0\n'); }
        else if (line) log('teclas: ' + line);
      }
    });
    child.stderr.on('data', (d) => { const s = String(d).trim(); if (s && !s.startsWith('#< CLIXML')) log('teclas: ' + s.slice(0, 200)); });
    child.on('exit', (code) => {
      log(`teclas: auxiliar terminado (${code})`);
      if (code) failed = true; // no se reintenta en bucle
      child = null;
    });
    child.on('error', () => { failed = true; child = null; });
  }

  function setActive(on) {
    want = !!on;
    if (want) start();
    if (child && child.stdin.writable) child.stdin.write(want ? '1\n' : '0\n');
  }

  function stop() { if (child) { try { child.stdin.end(); child.kill(); } catch { /* ignore */ } child = null; } }

  return { setActive, stop };
}

module.exports = { createKeyHook };
