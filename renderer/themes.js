'use strict';
// Esquemas de color del terminal
const base = (bg, fg, cursor, sel, ansi) => ({
  background: bg, foreground: fg, cursor, cursorAccent: bg, selectionBackground: sel,
  black: ansi[0], red: ansi[1], green: ansi[2], yellow: ansi[3], blue: ansi[4], magenta: ansi[5], cyan: ansi[6], white: ansi[7],
  brightBlack: ansi[8], brightRed: ansi[9], brightGreen: ansi[10], brightYellow: ansi[11],
  brightBlue: ansi[12], brightMagenta: ansi[13], brightCyan: ansi[14], brightWhite: ansi[15],
});

window.TERM_THEMES = {
  reax: { name: 'ReaX Noche', colors: base('#0b0e14', '#d6deeb', '#5b9bff', '#2a3b5c', ['#1d2230', '#ff6b7a', '#5fe3a1', '#ffd36b', '#5b9bff', '#c792ea', '#5ad4e6', '#c8d0e0', '#4b5468', '#ff8a96', '#7ff0b8', '#ffe08f', '#82b4ff', '#d7a8f5', '#7fe3f0', '#ffffff']) },
  moba: { name: 'Clásico Moba', colors: base('#000000', '#e5e5e5', '#00ff00', '#3a3a3a', ['#000000', '#cd0000', '#00cd00', '#cdcd00', '#3b78ff', '#cd00cd', '#00cdcd', '#e5e5e5', '#7f7f7f', '#ff0000', '#00ff00', '#ffff00', '#5c5cff', '#ff00ff', '#00ffff', '#ffffff']) },
  dracula: { name: 'Dracula', colors: base('#282a36', '#f8f8f2', '#f8f8f2', '#44475a', ['#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2', '#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff']) },
  nord: { name: 'Nord', colors: base('#2e3440', '#d8dee9', '#d8dee9', '#434c5e', ['#3b4252', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0', '#4c566a', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#8fbcbb', '#eceff4']) },
  onedark: { name: 'One Dark', colors: base('#21252b', '#abb2bf', '#528bff', '#3e4451', ['#282c34', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#abb2bf', '#5c6370', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#ffffff']) },
  gruvbox: { name: 'Gruvbox', colors: base('#282828', '#ebdbb2', '#ebdbb2', '#504945', ['#282828', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#a89984', '#928374', '#fb4934', '#b8bb26', '#fabd2f', '#83a598', '#d3869b', '#8ec07c', '#ebdbb2']) },
  solarized: { name: 'Solarized Oscuro', colors: base('#002b36', '#93a1a1', '#93a1a1', '#073642', ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5', '#586e75', '#cb4b16', '#93a1a1', '#839496', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3']) },
  monokai: { name: 'Monokai', colors: base('#272822', '#f8f8f2', '#f8f8f0', '#49483e', ['#272822', '#f92672', '#a6e22e', '#f4bf75', '#66d9ef', '#ae81ff', '#a1efe4', '#f8f8f2', '#75715e', '#f92672', '#a6e22e', '#f4bf75', '#66d9ef', '#ae81ff', '#a1efe4', '#f9f8f5']) },
  matrix: { name: 'Matrix', colors: base('#020a04', '#3dff6e', '#3dff6e', '#0f3d1d', ['#020a04', '#2bd65a', '#3dff6e', '#a8ff60', '#1fa34a', '#3dff6e', '#6dffa0', '#b8ffcc', '#145c2a', '#3dff6e', '#7dff9e', '#c8ffb0', '#2bd65a', '#7dff9e', '#a0ffc0', '#e0ffe8']) },
  light: { name: 'Claro', colors: base('#fbfcfe', '#24292f', '#2f6feb', '#c8dafc', ['#24292f', '#cf222e', '#116329', '#9a6700', '#0550ae', '#8250df', '#1b7c83', '#6e7781', '#57606a', '#a40e26', '#1a7f37', '#7d4e00', '#0969da', '#8250df', '#3192aa', '#8c959f']) },
};
