@echo off
rem Inicia ReaXTerm desde el código fuente (requiere Node.js)
cd /d "%~dp0"
if not exist node_modules\electron\dist\electron.exe (
  echo Instalando dependencias por primera vez...
  call npm install
  node node_modules\electron\install.js
)
start "" node_modules\electron\dist\electron.exe .
