# ReaXTerm

Terminal moderno para administrar servidores desde Windows, inspirado en MobaXterm. Reúne SSH, SFTP, FTP, Telnet, RDP, puerto serie, túneles, multi-ejecución y herramientas de red en una interfaz en español con tema oscuro o claro.

## Cómo abrirlo

- **Versión portable:** `dist\ReaXTerm-Portable-1.0.0.exe`. Es un solo archivo, no requiere instalación y puedes copiarlo donde quieras.
- **Desde el código:** doble clic en `Iniciar ReaXTerm.bat`, o `npm start`.
- **Instalador:** `dist\ReaXTerm Setup 1.0.0.exe`. Instala ReaXTerm y crea un acceso directo; para actualizar, vuelve a ejecutar el instalador nuevo. Ambas versiones son el mismo programa y comparten sesiones y ajustes.
- **Generar de nuevo el ejecutable:** `npm run dist` (crea la versión portable y el instalador en `dist\`).

Los ejecutables no están firmados. Para que el Control inteligente de aplicaciones de Windows no los bloquee, `build/afterPack.js` deja `ReaXTerm.exe` idéntico al `electron.exe` original, que Windows reconoce. Por eso el archivo `.exe` en sí muestra el ícono de Electron. El ícono de ReaXTerm va en `resources\icon.ico`: lo usan la ventana, la barra de tareas y los accesos directos que crea el instalador (`build/installer.nsh`).

## Funciones

| Área | Qué incluye |
|---|---|
| **Sesiones** | SSH, Telnet, terminal local (PowerShell, CMD, PowerShell 7, WSL, Git Bash), escritorio remoto (RDP), SFTP y FTP/FTPS (sólo explorador de archivos, en la propia pestaña) y puerto serie (COM, con velocidad, bits de datos, paridad, bits de parada y control de flujo). Se organizan en un árbol de carpetas y subcarpetas: arrastra sesiones o carpetas para moverlas, y con clic derecho en una carpeta puedes crear una sesión dentro, asignar una credencial a toda la carpeta, conectar todas, renombrarla o elegir su **color e ícono**. La vista es compacta: usuario, servidor y credencial aparecen al pasar el mouse (se puede desactivar en Ajustes › Comportamiento). Selecciona varias con Ctrl+clic o Mayús+clic para moverlas, asignarles una credencial, conectarlas o eliminarlas con **Supr** (pide confirmación con la cantidad). Puedes marcarlas como favoritas, etiquetarlas por color, añadir notas, buscarlas y ver las recientes. **Duplicar** abre directamente el editor de la copia. |
| **Credenciales** | Gestor de usuario y contraseña reutilizables: una credencial se asigna a muchas sesiones y, si cambias la contraseña, se actualiza en todas. En Ajustes › **Credenciales** hay un administrador para crearlas, editarlas, copiarlas y eliminarlas. Si una credencial no tiene usuario o contraseña, se piden la primera vez que conectas y quedan guardadas (cifradas con DPAPI). |
| **Autenticación SSH** | Contraseña (guardada cifrada con DPAPI de Windows), clave privada OpenSSH, PEM o PuTTY `.ppk` con frase de paso, agente SSH de Windows y keyboard-interactive (2FA). Verifica la huella del servidor y avisa si la clave cambia. |
| **Explorador SFTP** | Se abre solo al conectar por SSH. Permite navegar, subir y descargar archivos y carpetas (también arrastrando desde el Explorador de Windows), renombrar, borrar, crear archivos y carpetas, y cambiar permisos (chmod). Incluye un editor integrado (Ctrl+S guarda en el servidor), la opción **Abrir con editor externo**, que sube los cambios automáticamente al guardar, y **Seguir a la terminal**, un interruptor que hace que el explorador abra el directorio del shell cada vez que cambia, sin escribir nada visible en la terminal (bash y zsh). Muestra el progreso de las transferencias. |
| **Terminal** | Pestañas que se pueden arrastrar para reordenarlas, renombrar con doble clic y cerrar con clic central. Incluye vista en mosaico, búsqueda, enlaces que se abren con un clic, aceleración por GPU, zoom con Ctrl+rueda, registro de la sesión en un archivo, exportación del búfer, aviso al pegar varias líneas. Cuando una sesión se cierra, **R** la reconecta y **Enter** cierra la pestaña. |
| **Multi-ejecución** | Escribe en todas las pestañas conectadas a la vez. Al activarla se abre un mosaico temporal con todas las terminales a la vista, que vuelve a pestañas al desactivarla. Cada pestaña puede excluirse por separado. |
| **Túneles SSH** | Local (-L), remoto (-R) y dinámico SOCKS5 (-D), con inicio automático al abrir la aplicación. |
| **Comandos guardados** | Biblioteca de comandos frecuentes que se envían con un clic, a una pestaña o a todas. |
| **Herramientas** | Ping, tracert, comprobación de puerto, escáner de puertos, consulta DNS, generador de claves SSH (Ed25519, ECDSA o RSA), generador de contraseñas, información de red y gestión de servidores conocidos. |
| **Productividad** | Conexión rápida (`usuario@host:puerto`, `telnet host`, `rdp host`), paleta de comandos (Ctrl+Shift+P) y atajos de teclado. |
| **Migración** | Importa sesiones de MobaXterm (con usuarios y contraseñas), PuTTY/KiTTY, mRemoteNG, OpenSSH config, archivos .rdp, Excel, CSV y JSON. Exporta e importa la configuración completa en un archivo `.rxbackup` cifrado con contraseña. |
| **Personalización** | Tema oscuro, claro o del sistema, 8 colores de acento, 10 esquemas de color para la terminal, y opciones de fuente, cursor y comportamiento (copiar al seleccionar, pegar con clic derecho…). |

### Importar sesiones
Sesiones › ⋮ › **Importar sesiones…** (o la tarjeta de la pantalla de inicio) reúne todas las fuentes:

| Fuente | Qué se lee |
|---|---|
| PuTTY / KiTTY | Las sesiones guardadas en el registro de este equipo, o un archivo `.reg` exportado. SSH, Telnet y serie, con usuario y clave .ppk. |
| mRemoteNG | `confCons.xml` con su árbol de carpetas (SSH, Telnet, RDP), o su exportación CSV. Sus contraseñas cifradas no se importan. |
| OpenSSH | `%USERPROFILE%\.ssh\config` (HostName, User, Port, IdentityFile). |
| Archivos .rdp | Servidor, puerto y usuario. |
| Excel (.xlsx), CSV o JSON | Columnas reconocidas por nombre, en español o inglés: nombre, host/IP, puerto, usuario, dominio, protocolo, carpeta, notas y contraseña. Si el Excel tiene varias hojas y no hay columna de carpeta, cada hoja es una carpeta. Las contraseñas se guardan cifradas con DPAPI. |

### Importar desde MobaXterm
En MobaXterm, haz clic derecho en *User sessions* y elige **Export all sessions to file**. Luego, en ReaXTerm, ve a Sesiones › ⋮ › **Importar sesiones…** › **MobaXterm**. Se importan las sesiones SSH, SFTP, FTP, Telnet, RDP, de puerto serie, WSL y de shell local, con su árbol de carpetas.

Las sesiones que en MobaXterm usan una credencial guardada se vinculan a una credencial de ReaXTerm con el mismo nombre. Para traer también los **usuarios** de esas credenciales, selecciona a la vez tu archivo `.mxtsessions` y tu `MobaXterm.ini` (normalmente en `%APPDATA%\MobaXterm\`) en el diálogo de importación.

Si vuelves a importar, las sesiones que ya existían se actualizan (carpeta y credencial) en lugar de duplicarse.

### Importar contraseñas desde MobaXterm
1. En MobaXterm: **Settings › Configuration › General › MobaXterm passwords management** y pulsa **Export to file**. Se genera `MobaXterm Stored Passwords.txt`.
2. En ReaXTerm: panel **Credenciales** › botón de importar (o Sesiones › ⋮ › **Importar sesiones…** › **Contraseñas de MobaXterm**).

Se rellenan las contraseñas de las credenciales (por nombre) y las de las sesiones sin credencial que coincidan en servidor y usuario. Quedan cifradas con DPAPI. Ese archivo tiene tus contraseñas en texto plano: al terminar, ReaXTerm ofrece enviarlo a la papelera, y conviene vaciarla después. ReaXTerm no lee el archivo cifrado `.mobaconf`.

## Respaldo completo
Ajustes › Datos y respaldo › **Exportar configuración** (o Sesiones › ⋮). Genera un archivo `.rxbackup` con sesiones, credenciales y contraseñas, comandos, túneles, ajustes, recientes y servidores conocidos, cifrado con **AES-256-GCM** y una clave derivada con **scrypt** de la contraseña que elijas (mínimo 8 caracteres). Sin esa contraseña el archivo no se puede abrir y no hay forma de recuperarla.

Al importarlo (también en otro equipo) se pide la contraseña y puedes elegir **Combinar**, que agrega lo que falta y completa contraseñas sin tocar lo demás, o **Reemplazar todo**. Las contraseñas se vuelven a cifrar con DPAPI para el equipo de destino.

## Atajos

| Acción | Atajo |
|---|---|
| Paleta de comandos | Ctrl+Shift+P |
| Nueva sesión / terminal local | Ctrl+Shift+N / Ctrl+Shift+T |
| Cerrar pestaña | Ctrl+Shift+W |
| Cambiar de pestaña | Ctrl+Tab, Alt+1…9 |
| Multi-ejecución / mosaico | Ctrl+Shift+M / Ctrl+Shift+L |
| Buscar en la terminal | Ctrl+Shift+F |
| Copiar / pegar | Ctrl+C (con selección), Ctrl+V |
| Panel lateral | Ctrl+Shift+B |
| Zoom de fuente | Ctrl + / Ctrl − / Ctrl 0 |
| Pantalla completa / DevTools | F11 / F12 |
| Sesiones: seleccionar varias | Ctrl+clic, Mayús+clic, Ctrl+A |
| Sesiones: conectar / eliminar la selección | Enter / Supr |
| Sesión cerrada: reconectar / cerrar pestaña | R / Enter |

## Diferencias con MobaXterm

Funciones de MobaXterm que no están incluidas: el servidor X11 integrado, VNC, S3 y los comandos Unix de Cygwin. Para usar herramientas Linux en local, abre una pestaña **WSL** o **Git Bash**.

En RDP, la contraseña guardada todavía no se entrega al Escritorio remoto de Windows: `mstsc` la pide al conectar.

## Datos

Las sesiones y los ajustes se guardan en `%APPDATA%\reaxterm\reaxterm-data.json`. Las contraseñas (de sesiones y de credenciales) se cifran con DPAPI y solo puede leerlas tu usuario de Windows en este equipo. Para llevarlas a otro equipo usa el respaldo completo cifrado. La versión portable y la instalada usan este mismo archivo.

## Política de firma de código

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).

- Los ejecutables publicados en *Releases* se compilan en GitHub Actions a partir de este repositorio (`.github/workflows/release.yml`) y se firman con SignPath. No se firma nada compilado fuera de ese flujo.
- **Autores y revisores:** Alfredo Garrido (mantenedor). **Aprobador de cada firma:** Alfredo Garrido.
- Se firman `ReaXTerm.exe`, el instalador y la versión portable. Los módulos de terceros incluidos (Electron, node-pty, ssh2, serialport) se distribuyen tal como los publican sus autores.

**Privacidad:** ReaXTerm no envía información a ningún sistema en red salvo a los servidores a los que el usuario decide conectarse (SSH, SFTP, FTP, Telnet, RDP, túneles y herramientas de red). No incluye telemetría ni comprobación de actualizaciones.

## Estructura

```
main.js            Proceso principal: SSH/SFTP (ssh2), FTP, puerto serie (serialport), terminal local (node-pty), Telnet, túneles, herramientas
preload.js         Puente IPC seguro (contextIsolation + sandbox)
src/mobaimport.js  Importador de sesiones y contraseñas de MobaXterm
src/importers.js   Importadores de PuTTY/KiTTY, mRemoteNG, OpenSSH, .rdp, Excel, CSV y JSON
src/ftpfs.js       Cliente FTP/FTPS con la misma interfaz que SFTP
src/backup.js      Respaldo cifrado (.rxbackup)
renderer/          Interfaz: index.html, styles.css, app.js, icons.js, themes.js (xterm.js)
assets/            Logo e icono
```
