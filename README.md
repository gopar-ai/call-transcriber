# Transcripción automática de llamadas de Meet

Extensión de Chrome que detecta cuando entras a una llamada, la transcribe sola y deja un Google Doc por llamada con resumen ejecutivo, puntos clave y pendientes como casillas reales — sin que toques un botón, y sin pelearse con "Presentar pantalla".

## Para qué sirve

Tomar notas en una llamada es elegir entre dos cosas mal hechas: o escuchas o escribes. Y las grabaciones que quedan como un archivo de audio de 40 minutos tampoco sirven, porque nadie las vuelve a abrir.

Aquí la llamada termina y el documento ya está escrito. No hay que acordarse de darle a grabar, ni de mandarlo, ni de resumirlo después. Los pendientes quedan como casillas que de verdad se pueden marcar, así que la nota funciona como lista de trabajo y no solo como archivo muerto.

Y lo que lo hace usable en el día a día: **puedes presentar tu pantalla en la misma llamada sin que se rompa nada.** Esa es justamente la razón por la que la mayoría de las herramientas de este tipo se terminan desinstalando.

## Cómo funciona

```
Entras a una llamada de Meet
          │
          ▼
La extensión lo detecta sola  ──►  widget flotante, arrastrable
          │
          ▼
Audio leído de las conexiones WebRTC internas de Meet
   (tu micrófono + cada participante, mezclados)
          │
          ▼
Al colgar — también detectado solo
          │
          ├─► Whisper          ──►  transcripción
          ├─► GPT-4o-mini      ──►  resumen, puntos clave, pendientes
          └─► Google Docs API  ──►  un documento por llamada
```

Si la subida falla porque no hay red o el backend está caído, la grabación se descarga en local en vez de perderse.

---

## El truco técnico

La forma obvia de construir esto es capturar el audio con `getDisplayMedia()`, el selector de "elige qué compartir". Funciona, pero tiene un costo que lo vuelve inservible: mientras esa pestaña se está capturando así, ya no puedes usar el "presentar pantalla" de la propia plataforma sin conflicto. Para quien presenta seguido en llamadas, eso descalifica la herramienta.

La salida está en que Meet es una aplicación WebRTC: el audio de la llamada ya pasa por objetos `RTCPeerConnection` dentro del JavaScript de la página antes de llegar a tus bocinas. Un content script en el mundo `MAIN`, inyectado en `document_start` — antes de que corra el código de Meet — parchea `RTCPeerConnection` y `getUserMedia` para leer esas pistas de audio directo, las mezcla con la Web Audio API y graba con `MediaRecorder`.

Cero captura de pantalla o de pestaña. Por eso nunca compite con presentar.

El video es el único caso que sí necesita captura, porque no hay forma de leer pixeles sin ella. Por eso es opcional y usa una cadena de respaldo: primero `chrome.tabCapture`, que no muestra selector, y solo si no está disponible cae al selector de `getDisplayMedia`.

## El widget en la llamada

> Pendiente: captura del widget flotante durante una llamada (`docs/screenshots/widget-en-llamada.png`).

El widget se arrastra y recuerda dónde lo dejaste, dice en texto explícito qué está haciendo — "Transcribiendo" o "Grabando video y transcribiendo", para que nunca haya duda — y trae un selector de destino para mandar el documento a un Drive u otro según la cuenta.

---

## Setup

**Extensión**

1. `chrome://extensions` → activar Modo desarrollador → "Cargar descomprimida" → elegir `extension/`
2. Cambiar la constante `SERVER_URL` en `extension/content.js` y `extension/recorder.js` para que apunte a tu backend.

**Backend**

```bash
cd server
npm install
cp .env.example .env
npm start
```

## Variables de entorno

| Variable | Descripción |
|---|---|
| `OPENAI_API_KEY` | Whisper para transcribir y GPT-4o-mini para el resumen |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Credenciales de la cuenta de servicio, el JSON completo en una línea |
| `DRIVE_FOLDER_ID` | Carpeta donde caen los documentos del destino principal |
| `DRIVE_FOLDER_ID_PERSONAL` | Segundo destino opcional — el widget trae un selector para mandar cada llamada a un Drive distinto |

## Un detalle de Google Drive que cuesta horas

Las cuentas de servicio no tienen cuota de almacenamiento propia. Crear un archivo directamente en una carpeta de "Mi unidad" falla con `storageQuotaExceeded`, **aunque la carpeta esté compartida con la cuenta de servicio como editor**. La carpeta destino tiene que vivir dentro de una **unidad compartida**, donde el almacenamiento se cobra a la organización y no a quien creó el archivo. Y `drive.files.create` necesita `supportsAllDrives: true` explícito.

## Notas

- Varias personas pueden transcribir la misma llamada de forma independiente: nada del lado del servidor está atado a un usuario, cada navegador sube a donde esté configurado.
- La salida del resumen es JSON estructurado, no texto libre parseado a mano.
- El documento se arma con `batchUpdate` y aritmética de índices, para que los encabezados, viñetas, casillas e hipervínculos sean formato real de Google Docs y no texto que lo imite.

---

## Tech stack

- **Extensión de Chrome (Manifest V3)** — content scripts en mundo `MAIN` e `ISOLATED`, service worker
- **WebRTC + Web Audio API** — lectura y mezcla del audio sin capturar pantalla
- **MediaRecorder** — grabación en el navegador
- **Node.js + Express** — backend que recibe, transcribe y genera el documento
- **Whisper** — transcripción
- **GPT-4o-mini** — resumen con salida estructurada
- **Google Docs y Drive API** — documento con formato real y subida del video
