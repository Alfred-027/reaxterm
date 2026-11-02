# ReaXTerm

Terminal moderno para administrar servidores desde Windows, inspirado en MobaXterm. ReÃºne SSH, SFTP, FTP, Telnet, RDP, puerto serie, tÃºneles, multi-ejecuciÃ³n y herramientas de red en una interfaz en espaÃ±ol con tema oscuro o claro.

## CÃ³mo abrirlo

- **VersiÃ³n portable:** `dist\ReaXTerm-Portable-1.1.0.exe`. Es un solo archivo, no requiere instalaciÃ³n y puedes copiarlo donde quieras.
- **Desde el cÃ³digo:** doble clic en `Iniciar ReaXTerm.bat`, o `npm start`.
- **Instalador:** `dist\ReaXTerm Setup 1.1.0.exe`. Instala ReaXTerm y crea un acceso directo; para actualizar, vuelve a ejecutar el instalador nuevo. Ambas versiones son el mismo programa y comparten sesiones y ajustes.
- **Generar de nuevo el ejecutable:** `npm run dist` (crea la versiÃ³n portable y el instalador en `dist\`).

Los ejecutables no estÃ¡n firmados. Para que el Control inteligente de aplicaciones de Windows no los bloquee, `build/afterPack.js` deja `ReaXTerm.exe` idÃ©ntico al `electron.exe` original, que Windows reconoce. Por eso el archivo `.exe` en sÃ­ muestra el Ã­cono de Electron. El Ã­cono de ReaXTerm va en `resources\icon.ico`: lo usan la ventana, la barra de tareas y los accesos directos que crea el instalador (`build/installer.nsh`).

## Funciones

| Ãrea | QuÃ© incluye |
|---|---|
| **Sesiones** | SSH, Telnet, terminal local (PowerShell, CMD, PowerShell 7, WSL, Git Bash), escritorio remoto (RDP), SFTP y FTP/FTPS (sÃ³lo explorador de archivos, en la propia pestaÃ±a) y puerto serie (COM, con velocidad, bits de datos, paridad, bits de parada y control de flujo). Se organizan en un Ã¡rbol de carpetas y subcarpetas: arrastra sesiones o carpetas para moverlas, y con clic derecho en una carpeta puedes crear una sesiÃ³n dentro, asignar una credencial a toda la carpeta, conectar todas, renombrarla o elegir su **color e Ã­cono**. La vista es compacta: usuario, servidor y credencial aparecen al pasar el mouse (se puede desactivar en Ajustes â€º Comportamiento). Selecciona varias con Ctrl+clic o MayÃºs+clic para moverlas, asignarles una credencial, conectarlas o eliminarlas con **Supr** (pide confirmaciÃ³n con la cantidad). Puedes marcarlas como favoritas, etiquetarlas por color, aÃ±adir notas, buscarlas y ver las recientes. **Duplicar** abre directamente el editor de la copia. |
| **Credenciales** | Gestor de usuario y contraseÃ±a reutilizables: una credencial se asigna a muchas sesiones y, si cambias la contraseÃ±a, se actualiza en todas. En Ajustes â€º **Credenciales** hay un administrador para crearlas, editarlas, copiarlas y eliminarlas. Si una credencial no tiene usuario o contraseÃ±a, se piden la primera vez que conectas y quedan guardadas (cifradas con DPAPI). |
| **AutenticaciÃ³n SSH** | ContraseÃ±a (guardada cifrada con DPAPI de Windows), clave privada OpenSSH, PEM o PuTTY `.ppk` con frase de paso, agente SSH de Windows y keyboard-interactive (2FA). Verifica la huella del servidor y avisa si la clave cambia. |
| **Explorador SFTP** | Se abre solo al conectar por SSH. Permite navegar, subir y descargar archivos y carpetas (tambiÃ©n arrastrando desde el Explorador de Windows), renombrar, borrar, crear archivos y carpetas, y cambiar permisos (chmod). Incluye un editor integrado (Ctrl+S guarda en el servidor), la opciÃ³n **Abrir con editor externo**, que sube los cambios automÃ¡ticamente al guardar, y **Seguir a la terminal**, un interruptor que hace que el explorador abra el directorio del shell cada vez que cambia, sin escribir nada visible en la terminal (bash y zsh). Muestra el progreso de las transferencias. |
| **Terminal** | PestaÃ±as que se pueden arrastrar para reordenarlas, renombrar con doble clic y cerrar con clic central. Incluye vista en mosaico, bÃºsqueda, enlaces que se abren con un clic, aceleraciÃ³n por GPU, zoom con Ctrl+rueda, registro de la sesiÃ³n en un archivo, exportaciÃ³n del bÃºfer, aviso al pegar varias lÃ­neas. Cuando una sesiÃ³n se cierra, **R** la reconecta y **Enter** cierra la pestaÃ±a. |
| **Multi-ejecuciÃ³n** | Escribe en todas las pestaÃ±as conectadas a la vez. Al activarla se abre un mosaico temporal con todas las terminales a la vista, que vuelve a pestaÃ±as al desactivarla. Cada pestaÃ±a puede excluirse por separado. |
| **TÃºneles SSH** | Local (-L), remoto (-R) y dinÃ¡mico SOCKS5 (-D), con inicio automÃ¡tico al abrir la aplicaciÃ³n. |
| **Comandos guardados** | Biblioteca de comandos frecuentes que se envÃ­an con un clic, a una pestaÃ±a o a todas. |
| **Herramientas** | Ping, tracert, comprobaciÃ³n de puerto, escÃ¡ner de puertos, consulta DNS, generador de claves SSH (Ed25519, ECDSA o RSA), generador de contraseÃ±as, informaciÃ³n de red y gestiÃ³n de servidores conocidos. |
| **Productividad** | ConexiÃ³n rÃ¡pida (`usuario@host:puerto`, `telnet host`, `rdp host`), paleta de comandos (Ctrl+Shift+P) y atajos de teclado. Lo que abres desde la barra queda en la secciÃ³n **Conexiones rÃ¡pidas** del panel de sesiones (las 40 mÃ¡s recientes), con el usuario y la contraseÃ±a que escribiste al conectar, cifrados. Para guardarla en **Mis sesiones**, arrÃ¡strala a una carpeta o usa clic derecho â€º *Guardar en Mis sesionesâ€¦*. Para cambiar el nombre de una sesiÃ³n sin abrir el editor, selecciÃ³nala y pulsa **F2** (o clic derecho â€º *Cambiar nombre*): Enter guarda y Esc cancela. |
| **MigraciÃ³n** | Importa sesiones de MobaXterm (con usuarios y contraseÃ±as), PuTTY/KiTTY, mRemoteNG, OpenSSH config, archivos .rdp, Excel, CSV y JSON. Exporta e importa la configuraciÃ³n completa en un archivo `.rxbackup` cifrado con contraseÃ±a. |
| **PersonalizaciÃ³n** | Tema oscuro, claro o del sistema, 8 colores de acento, 10 esquemas de color para la terminal, y opciones de fuente, cursor y comportamiento (copiar al seleccionar, pegar con clic derechoâ€¦). |

### Importar sesiones
Sesiones â€º â‹® â€º **Importar sesionesâ€¦** (o la tarjeta de la pantalla de inicio) reÃºne todas las fuentes:

| Fuente | QuÃ© se lee |
|---|---|
| PuTTY / KiTTY | Las sesiones guardadas en el registro de este equipo, o un archivo `.reg` exportado. SSH, Telnet y serie, con usuario y clave .ppk. |
| mRemoteNG | `confCons.xml` con su Ã¡rbol de carpetas (SSH, Telnet, RDP), o su exportaciÃ³n CSV. Sus contraseÃ±as cifradas no se importan. |
| OpenSSH | `%USERPROFILE%\.ssh\config` (HostName, User, Port, IdentityFile). |
| Archivos .rdp | Servidor, puerto y usuario. |
| Excel (.xlsx), CSV o JSON | Columnas reconocidas por nombre, en espaÃ±ol o inglÃ©s: nombre, host/IP, puerto, usuario, dominio, protocolo, carpeta, notas y contraseÃ±a. Si el Excel tiene varias hojas y no hay columna de carpeta, cada hoja es una carpeta. Las contraseÃ±as se guardan cifradas con DPAPI. |

### Importar desde MobaXterm
En MobaXterm, haz clic derecho en *User sessions* y elige **Export all sessions to file**. Luego, en ReaXTerm, ve a Sesiones â€º â‹® â€º **Importar sesionesâ€¦** â€º **MobaXterm**. Se importan las sesiones SSH, SFTP, FTP, Telnet, RDP, de puerto serie, WSL y de shell local, con su Ã¡rbol de carpetas.

Las sesiones que en MobaXterm usan una credencial guardada se vinculan a una credencial de ReaXTerm con el mismo nombre. Para traer tambiÃ©n los **usuarios** de esas credenciales, selecciona a la vez tu archivo `.mxtsessions` y tu `MobaXterm.ini` (normalmente en `%APPDATA%\MobaXterm\`) en el diÃ¡logo de importaciÃ³n.

Si vuelves a importar, las sesiones que ya existÃ­an se actualizan (carpeta y credencial) en lugar de duplicarse.

### Importar contraseÃ±as desde MobaXterm
1. En MobaXterm: **Settings â€º Configuration â€º General â€º MobaXterm passwords management** y pulsa **Export to file**. Se genera `MobaXterm Stored Passwords.txt`.
2. En ReaXTerm: panel **Credenciales** â€º botÃ³n de importar (o Sesiones â€º â‹® â€º **Importar sesionesâ€¦** â€º **ContraseÃ±as de MobaXterm**).

Se rellenan las contraseÃ±as de las credenciales (por nombre) y las de las sesiones sin credencial que coincidan en servidor y usuario. Quedan cifradas con DPAPI. Ese archivo tiene tus contraseÃ±as en texto plano: al terminar, ReaXTerm ofrece enviarlo a la papelera, y conviene vaciarla despuÃ©s. ReaXTerm no lee el archivo cifrado `.mobaconf`.

## Respaldo completo
Ajustes â€º Datos y respaldo â€º **Exportar configuraciÃ³n** (o Sesiones â€º â‹®). Genera un archivo `.rxbackup` con sesiones, credenciales y contraseÃ±as, comandos, tÃºneles, ajustes, recientes y servidores conocidos, cifrado con **AES-256-GCM** y una clave derivada con **scrypt** de la contraseÃ±a que elijas (mÃ­nimo 8 caracteres). Sin esa contraseÃ±a el archivo no se puede abrir y no hay forma de recuperarla.

Al importarlo (tambiÃ©n en otro equipo) se pide la contraseÃ±a y puedes elegir **Combinar**, que agrega lo que falta y completa contraseÃ±as sin tocar lo demÃ¡s, o **Reemplazar todo**. Las contraseÃ±as se vuelven a cifrar con DPAPI para el equipo de destino.

## Atajos

| AcciÃ³n | Atajo |
|---|---|
| Paleta de comandos | Ctrl+Shift+P |
| Nueva sesiÃ³n / terminal local | Ctrl+Shift+N / Ctrl+Shift+T |
| Cerrar pestaÃ±a | Ctrl+Shift+W |
| Cambiar de pestaÃ±a | Ctrl+Tab, Alt+1â€¦9 |
| Multi-ejecuciÃ³n / mosaico | Ctrl+Shift+M / Ctrl+Shift+L |
| Buscar en la terminal | Ctrl+Shift+F |
| Copiar / pegar | Ctrl+C (con selecciÃ³n), Ctrl+V |
| Panel lateral | Ctrl+Shift+B |
| Zoom de fuente | Ctrl + / Ctrl âˆ’ / Ctrl 0 |
| Pantalla completa / DevTools | F11 / F12 |
| Sesiones: seleccionar varias | Ctrl+clic, MayÃºs+clic, Ctrl+A |
| Sesiones: conectar / eliminar la selecciÃ³n | Enter / Supr |
| SesiÃ³n cerrada: reconectar / cerrar pestaÃ±a | R / Enter |

## Diferencias con MobaXterm

Funciones de MobaXterm que no estÃ¡n incluidas: el servidor X11 integrado, VNC, S3 y los comandos Unix de Cygwin. Para usar herramientas Linux en local, abre una pestaÃ±a **WSL** o **Git Bash**.

### RDP en pestaÃ±a (experimental)
Por defecto, las sesiones RDP se abren con el Escritorio remoto de Windows (`mstsc`), que pide la contraseÃ±a al conectar. En Ajustes â€º Comportamiento â€º **Sesiones RDP** se puede elegir abrirlas dentro de una pestaÃ±a de ReaXTerm, o hacerlo para una sesiÃ³n puntual con clic derecho â€º **Abrir en pestaÃ±a (integrado)**.

El modo integrado usa [IronRDP](https://github.com/Devolutions/IronRDP) (cliente RDP de cÃ³digo abierto en WebAssembly) con autenticaciÃ³n NLA/CredSSP, la credencial guardada y una resoluciÃ³n del tamaÃ±o de la pestaÃ±a al conectar. Si el servidor soporta cambiar la resoluciÃ³n en caliente (Windows 8.1 / Server 2012 R2 o superior), el escritorio se ajusta al redimensionar la pestaÃ±a; en servidores mÃ¡s antiguos, al terminar de redimensionar se reconecta con el tamaÃ±o nuevo (como mstsc), reutilizando la autenticaciÃ³n y volviendo a la misma sesiÃ³n de Windows. Con el foco en la sesiÃ³n, todo el teclado va al equipo remoto: los atajos de ReaXTerm no se aplican, y la tecla Windows (sola o con otra tecla), Ctrl+Esc y Alt+Tab se capturan con un hook de teclado (`src/keyhook.js`, un PowerShell auxiliar) para que no abran el menÃº Inicio local. Ctrl+Alt+Supr y Win+L los reserva Windows; para Ctrl+Alt+Supr estÃ¡ el botÃ³n de la barra que aparece al pasar el mouse por el borde superior. Para servidores antiguos (p. ej. Windows Server 2008 R2) el puente separa los mensajes agrupados, retiene los grÃ¡ficos que llegan durante la reactivaciÃ³n de la sesiÃ³n hasta que IronRDP puede dibujarlos, y corrige los bitmaps comprimidos con ancho de relleno (que IronRDP 0.7 dibuja inclinados): los descomprime (`src/rlebitmap.js`), los recorta y los entrega sin comprimir. Al cerrar la app con sesiones RDP abiertas se pide confirmaciÃ³n. Como el navegador no puede abrir conexiones TCP, el proceso principal hace de puente local (`src/rdpproxy.js`, protocolo RDCleanPath): sÃ³lo escucha en 127.0.0.1, exige un token de un solo uso por conexiÃ³n y verifica la huella del certificado del servidor como en SSH. AÃºn no comparte unidades, impresoras ni audio.

## Datos

Las sesiones y los ajustes se guardan en `%APPDATA%\reaxterm\reaxterm-data.json`. Las contraseÃ±as (de sesiones y de credenciales) se cifran con DPAPI y solo puede leerlas tu usuario de Windows en este equipo. Para llevarlas a otro equipo usa el respaldo completo cifrado. La versiÃ³n portable y la instalada usan este mismo archivo.

## PolÃ­tica de firma de cÃ³digo

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).

- Los ejecutables publicados en *Releases* se compilan en GitHub Actions a partir de este repositorio (`.github/workflows/release.yml`) y se firman con SignPath. No se firma nada compilado fuera de ese flujo.
- **Autores y revisores:** Alfredo Garrido (mantenedor). **Aprobador de cada firma:** Alfredo Garrido.
- Se firman `ReaXTerm.exe`, el instalador y la versiÃ³n portable. Los mÃ³dulos de terceros incluidos (Electron, node-pty, ssh2, serialport) se distribuyen tal como los publican sus autores.

**Privacidad:** ReaXTerm no envÃ­a informaciÃ³n a ningÃºn sistema en red salvo a los servidores a los que el usuario decide conectarse (SSH, SFTP, FTP, Telnet, RDP, tÃºneles y herramientas de red). No incluye telemetrÃ­a ni comprobaciÃ³n de actualizaciones.

## Estructura

```
main.js            Proceso principal: SSH/SFTP (ssh2), FTP, puerto serie (serialport), terminal local (node-pty), Telnet, tÃºneles, herramientas
preload.js         Puente IPC seguro (contextIsolation + sandbox)
src/mobaimport.js  Importador de sesiones y contraseÃ±as de MobaXterm
src/importers.js   Importadores de PuTTY/KiTTY, mRemoteNG, OpenSSH, .rdp, Excel, CSV y JSON
src/rdpproxy.js    Puente RDCleanPath local para el cliente RDP en WebAssembly
src/ftpfs.js       Cliente FTP/FTPS con la misma interfaz que SFTP
src/backup.js      Respaldo cifrado (.rxbackup)
renderer/          Interfaz: index.html, styles.css, app.js, icons.js, themes.js (xterm.js)
assets/            Logo e icono
```
