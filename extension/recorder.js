// Cambia esto por la URL de tu propio backend desplegado (ver server/README).
const SERVER_URL = "https://your-backend.up.railway.app";

const statusEl = document.getElementById("status");
const stopBtn = document.getElementById("stop");

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = kind || "";
  console.log("[call-transcriber]", text);
}

function withTimeout(promise, ms, timeoutMessage) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(timeoutMessage)), ms)),
  ]);
}

const params = new URLSearchParams(location.search);
const recordVideo = params.get("recordVideo") === "true";
const meetingName = params.get("meetingName") || "";
const driveDestination = params.get("destination") === "personal" ? "personal" : "work";
const streamIdParam = params.get("streamId") || "";
const tcErrorParam = params.get("tcError") || "";
const webrtcReasonParam = params.get("webrtcReason") || "";
if (webrtcReasonParam) {
  console.log("[call-transcriber] motivo de caída del modo sin captura:", webrtcReasonParam);
  const el = document.getElementById("webrtcReason");
  el.textContent = "Modo sin captura no disponible — " + webrtcReasonParam;
  el.style.display = "block";
}

let mediaRecorder = null;
let chunks = [];
let displayStream = null;
let micStream = null;
let audioContext = null;
let destination = null;
let usingTabCapture = false;

// Grabador de video aparte, solo se usa si el video se activa a medio de la
// llamada (cuando no se pidió desde el inicio) — MediaRecorder no permite
// agregar una pista de video a uno que ya está corriendo.
let videoRecorder = null;
let videoChunks = [];
let videoStartedLate = false;

async function captureViaTabCapture() {
  // Sin selector: no "gasta" el compartir pantalla, así "Presentar" en Meet
  // queda libre. streamId debe consumirse rápido, por eso se intenta primero
  // y con timeout corto — si falla, se cae al selector normal sin drama.
  const stream = await withTimeout(
    navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamIdParam } },
      video: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamIdParam } },
    }),
    6000,
    "tabCapture no respondió a tiempo"
  );
  usingTabCapture = true;
  return stream;
}

async function captureViaDisplayMedia(fallbackReason) {
  const reasonNote = fallbackReason ? ` [sin captura directa: ${fallbackReason}]` : "";
  setStatus('Elige la pestaña de la llamada (marca "Compartir audio de la pestaña")…' + reasonNote);
  const stream = await navigator.mediaDevices.getDisplayMedia({
    // displaySurface: "browser" limita el selector a solo pestañas de
    // Chrome — evita que por error se comparta toda la pantalla o una
    // ventana, que es justo lo que choca con "Presentar" dentro de Meet.
    video: { displaySurface: "browser" },
    audio: true,
  });
  usingTabCapture = false;
  return stream;
}

async function start() {
  try {
    let fallbackReason = tcErrorParam;
    if (!streamIdParam && !tcErrorParam) fallbackReason = "no se generó streamId (revisa el service worker)";

    if (streamIdParam) {
      try {
        displayStream = await captureViaTabCapture();
      } catch (err) {
        console.warn("[call-transcriber] tabCapture falló, usando selector manual:", err.message);
        fallbackReason = err.message;
        displayStream = null;
      }
    }
    if (!displayStream) {
      displayStream = await captureViaDisplayMedia(fallbackReason);
    }

    if (displayStream.getAudioTracks().length === 0) {
      displayStream.getTracks().forEach((t) => t.stop());
      throw new Error(
        'No se detectó audio de la pestaña. Vuelve a intentar y asegúrate de marcar "Compartir audio de la pestaña" en el selector.'
      );
    }

    // Si el usuario le da "Dejar de compartir" en la barra nativa de Chrome
    // (o cierra la pestaña de la llamada), lo tratamos como "Detener".
    displayStream.getVideoTracks()[0]?.addEventListener("ended", stop);

    setStatus("Pidiendo acceso al micrófono…");
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

    setStatus("Mezclando audio…");
    audioContext = new AudioContext();
    await audioContext.resume();
    destination = audioContext.createMediaStreamDestination();

    const tabSource = audioContext.createMediaStreamSource(displayStream);
    tabSource.connect(destination);
    if (usingTabCapture) {
      // tabCapture es exclusivo: sin reconectar a bocinas, la llamada se
      // quedaría muda para quien graba. getDisplayMedia no lo necesita.
      tabSource.connect(audioContext.destination);
    }
    // El mic solo se mezcla para grabar, no se reenvía a bocinas (evita eco).
    audioContext.createMediaStreamSource(micStream).connect(destination);

    const tracks = recordVideo
      ? [...destination.stream.getAudioTracks(), ...displayStream.getVideoTracks()]
      : destination.stream.getAudioTracks();
    const recordedStream = new MediaStream(tracks);

    chunks = [];
    mediaRecorder = new MediaRecorder(recordedStream, {
      mimeType: recordVideo ? "video/webm;codecs=vp8,opus" : "audio/webm;codecs=opus",
    });
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    mediaRecorder.start(1000);

    stopBtn.disabled = false;
    setStatus(recordVideo ? "Grabando (audio + video)…" : "Transcribiendo (sin grabar video)…", "ok");
    chrome.runtime.sendMessage({ action: "recording-confirmed" }).catch(() => {});
  } catch (err) {
    setStatus("Error: " + (err.message || err), "err");
    chrome.runtime.sendMessage({ action: "recording-failed" }).catch(() => {});
  }
}

function enableVideoNow() {
  if (recordVideo || videoRecorder || !displayStream || !destination) return;
  const vStream = new MediaStream([...destination.stream.getAudioTracks(), ...displayStream.getVideoTracks()]);
  videoChunks = [];
  videoRecorder = new MediaRecorder(vStream, { mimeType: "video/webm;codecs=vp8,opus" });
  videoRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) videoChunks.push(e.data);
  };
  videoRecorder.start(1000);
  videoStartedLate = true;
  setStatus("Grabando también video desde ahora…", "ok");
}

// Permite detener (o activar video) desde el botón flotante en la propia
// llamada, sin tener que cambiar a esta pestaña.
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === "trigger-stop") stop();
  if (message.action === "enable-video-now") enableVideoNow();
});

async function stop() {
  if (!mediaRecorder || mediaRecorder.state === "inactive") return;
  stopBtn.disabled = true;
  setStatus("Deteniendo grabador…");

  const blob = await new Promise((resolve) => {
    mediaRecorder.onstop = () => {
      resolve(new Blob(chunks, { type: recordVideo ? "video/webm" : "audio/webm" }));
    };
    mediaRecorder.stop();
  });

  let videoBlob = null;
  if (videoRecorder && videoRecorder.state !== "inactive") {
    videoBlob = await new Promise((resolve) => {
      videoRecorder.onstop = () => resolve(new Blob(videoChunks, { type: "video/webm" }));
      videoRecorder.stop();
    });
  }

  [displayStream, micStream].forEach((s) => s?.getTracks().forEach((t) => t.stop()));
  audioContext?.close();

  setStatus(`Archivo listo: ${(blob.size / 1024 / 1024).toFixed(1)} MB. Subiendo y transcribiendo…`);

  try {
    const formData = new FormData();
    formData.append("file", blob, "llamada.webm");
    formData.append("recordVideo", String(recordVideo || !!videoBlob));
    formData.append("meetingName", meetingName);
    formData.append("destination", driveDestination);
    if (videoBlob) {
      formData.append("videoFile", videoBlob, "llamada-video.webm");
      formData.append("videoPartial", String(videoStartedLate));
    }

    const res = await withTimeout(
      fetch(`${SERVER_URL}/calls`, { method: "POST", body: formData }),
      120000,
      "El servidor tardó más de 2 minutos en responder."
    );
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "El servidor regresó un error");

    statusEl.innerHTML = `Listo: <a href="${data.docUrl}" target="_blank" style="color:#00f5c4">abrir el documento</a>`;
    statusEl.className = "ok";
    window.open(data.docUrl, "_blank");
    chrome.runtime.sendMessage({ action: "recording-done", docUrl: data.docUrl }).catch(() => {});
  } catch (err) {
    setStatus("No se pudo subir (" + err.message + "). Se descarga localmente para no perder la grabación.", "err");
    const url = URL.createObjectURL(blob);
    const kind = recordVideo ? "video" : "audio";
    const filename = `llamada-${kind}-${new Date().toISOString().replace(/[:.]/g, "-")}.webm`;
    chrome.downloads.download({ url, filename, saveAs: false });
    chrome.runtime.sendMessage({ action: "recording-done" }).catch(() => {});
  }
}

stopBtn.addEventListener("click", stop);
start();
