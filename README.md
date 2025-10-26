# docx2pdf — Conversor DOCX → PDF (local)

Proyecto pequeño para convertir archivos `.docx` a `.pdf` mediante subida desde el navegador. El cliente envía el archivo (como binario) por Socket.IO, el servidor crea un archivo temporal, lo convierte usando utilidades platform-specific y devuelve el PDF resultante al cliente.

Este README explica cómo ejecutar el proyecto localmente, requisitos por plataforma, estructura del proyecto, cómo funcionan las conversiones y recomendaciones de seguridad/producción.

## Contenido
- Resumen y arquitectura
- Requisitos y dependencias
- Instalación y ejecución
- API de realtime (Socket.IO)
- Configuración y variables de entorno
- Seguridad y límites
- Problemas comunes y solución de fallos
- Desarrollo y tests
- Próximos pasos / mejoras

---

## 1) Resumen y arquitectura

Flujo principal:

1. El usuario en la UI (`public/index.html`) selecciona un `.docx`.
2. El cliente lee el archivo con `FileReader` y envía un `Uint8Array` al servidor por Socket.IO (`upload` event).
3. El servidor valida y encola el trabajo. Se escribe el buffer a un archivo temporal con permisos restringidos.
4. El servidor lanza un proceso de conversión (PowerShell / shell / `unoconv` según plataforma) en un proceso hijo no bloqueante.
5. Cuando la conversión termina el servidor lee el PDF y lo envía de vuelta al cliente con el evento `converted`.
6. El cliente crea un Blob y descarga el PDF automáticamente.

El código clave está en:
- `index.js` — servidor Express + Socket.IO.
- `public/index.html` y `public/index.css` — UI.
- `docx2pdf-converter/index.js` — lógica de conversión asíncrona (cola, validación, spawn, limpieza).

---

## 2) Requisitos y dependencias

Requisitos de Node (tested): Node 14+ (se recomienda 16+).

Dependencias Node (asegúrate de instalar):

```powershell
npm install express socket.io adm-zip
```

Dependencias por plataforma (requeridas para que la conversión funcione):

- Windows
  - Microsoft Word instalado.
  - PowerShell capaz de automatizar Word via COM (el script `convert.ps1` usa COM Automation). Ejecutar PowerShell con la política de ejecución adecuada.
- macOS
  - Script `convert.sh` que use AppleScript o `textutil`/`libreoffice` según implementación.
- Linux
  - `unoconv` + LibreOffice en modo headless (instala `libreoffice` y `unoconv`).

Nota: los scripts `convert.ps1` y `convert.sh` no están incluidos automáticamente en este README — deben existir en `docx2pdf-converter/` y ser apropiados para tu entorno.

---

## 3) Instalación y ejecución

1. Clona o copia el proyecto en tu máquina. Sitúate en la carpeta del proyecto:

```powershell
cd C:\Users\samue\Desktop\docx2pdf
```

2. Instala dependencias Node:

```powershell
npm install
npm install adm-zip --save
```

3. Asegúrate de que las utilidades de conversión por plataforma están disponibles y que los scripts `docx2pdf-converter/convert.ps1` y/o `convert.sh` existen y son ejecutables.

4. Ejecuta el servidor (PowerShell):

```powershell
node index.js
# o con nodemon si lo tienes:
npx nodemon index.js
```

5. Abre en el navegador: `http://localhost:3000` y sube un `.docx`.

---

## 4) API de realtime (Socket.IO)

Eventos (cliente → servidor):

- `upload`: payload `[Uint8Array, socketId?]` — el primer elemento debe ser el buffer del `.docx`.

Eventos (servidor → cliente):

- `converted`: payload `Buffer` (binario) — contiene el PDF resultante. El cliente lo recibe y lo descarga.
- `error`: payload `string` — mensaje de error legible.

Ejemplo (cliente): ya implementado en `public/index.html`.

---

## 5) Configuración y variables de entorno

Puedes ajustar vía variables de entorno:

- `MAX_DOCX_BYTES` — máximo bytes permitidos por `.docx` antes de rechazar (por defecto 15 MB).
- `DOCX2PDF_CONCURRENCY` — número de conversiones concurrentes permitidas (por defecto 2).

Ejemplo (PowerShell):

```powershell
$env:MAX_DOCX_BYTES = 20000000; $env:DOCX2PDF_CONCURRENCY = 3; node index.js
```

---

## 6) Seguridad y límites (importante)

Este servicio acepta archivos subidos por usuarios. Antes de exponerlo en producción, toma las siguientes precauciones:

1. Validación estricta: el servidor valida que el buffer recibido tenga cabecera ZIP (`PK\\x03\\x04`) y tamaño máximo. No confíes solo en la extensión del archivo.
2. Escaneo antivirus: integra un escáner (p. ej. ClamAV) en la pipeline para escanear archivos antes de encolarlos.
3. Sandboxing: ejecuta la conversión en máquinas/container aislados o en workers con permisos mínimos.
4. Límites de concurrencia y rate-limiting: usa `DOCX2PDF_CONCURRENCY` y añade límites por IP / usuario.
5. Ejecuta los scripts de conversión como un usuario sin privilegios (no como root/Administrator).
6. Asegura los scripts `convert.ps1` / `convert.sh` y evita ejecutar comandos construidos con entradas del usuario.

---

## 7) Errores, timeouts y limpieza

- Todos los procesos de conversión usan `spawn` y están limitados por `timeoutMs` (por defecto 60s). Si el proceso se cuelga, será terminado.
- Los archivos temporales se crean con `fs.mkdtemp` y se eliminan siempre en el bloque `finally`.
- Si ves errores tipo `Conversion failed with code X` revisa los scripts de conversión en `docx2pdf-converter/`.

---

## 8) Problemas comunes y soluciones

- `ENOTFOUND` al iniciar `unoconv` en Linux: instala `unoconv` y `libreoffice` y asegúrate de que `unoconv --version` funciona en la terminal.
- PowerShell no permite ejecutar scripts: ajusta la política de ejecución o firma los scripts (`Set-ExecutionPolicy Bypass -Scope Process`).
- Permisos en archivos temp: comprueba que Node puede escribir en `%TEMP%` o `/tmp`.

---

## 9) Desarrollo y pruebas

- Añadir tests unitarios: puedes comprobar `validateDocxBuffer` y simular `spawnConversion` con un stub.
- E2E: crea un `.docx` de ejemplo y sube desde la UI para verificar la cadena completa.

Comandos útiles:

```powershell
# Instalar deps
npm install

# Ejecutar servidor
node index.js

# Ejecutar con variables de entorno (PowerShell)
$env:MAX_DOCX_BYTES = 30000000; $env:DOCX2PDF_CONCURRENCY = 2; node index.js
```

---

## 10) Estructura del proyecto (relevante)

```
docx2pdf/
  ├─ docx2pdf-converter/        # módulo local con convertBuffer y scripts (convert.ps1, convert.sh)
  │    ├─ index.js
  │    ├─ convert.ps1
  │    └─ convert.sh
  ├─ node_modules/
  ├─ public/
  │    ├─ index.html
  │    └─ index.css
  ├─ index.js                    # servidor express + socket.io
  ├─ package.json
  └─ README.md
```

---

## 11) Próximos pasos recomendados

1. Agregar escaneo antivirus antes de encolar.
2. Externalizar conversiones a un pool de workers o servicios (p. ej. microservicio con cola Redis + Bull para resiliencia).
3. Añadir autenticación/autorization y límites por usuario/IP.
4. Monitorización: exportar métricas (duración por job, errores, cola) y alertas.
5. Tests E2E y CI que validen conversiones en un runner que tenga LibreOffice/Office instalado.

---

Si quieres, puedo:
- añadir un README en `docx2pdf-converter/` con instrucciones específicas para crear `convert.ps1` y `convert.sh`;
- crear un script para comprobar dependencias (unoconv/powershell/etc.);
- añadir una integración simple con ClamAV para escanear archivos antes de encolarlos.

Dime cuál prefieres y lo implemento.
