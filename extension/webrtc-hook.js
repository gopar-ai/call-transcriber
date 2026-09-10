// Corre en el contexto REAL de la página de Meet (world: MAIN), inyectado en
// document_start — antes de que el propio código de Meet cree sus conexiones
// WebRTC. Engancha RTCPeerConnection y getUserMedia para leer el audio de la
// llamada (el de los demás participantes + el propio micrófono) directo,
// SIN usar captura de pantalla/pestaña — por eso nunca choca con "Presentar".
//
// Si por lo que sea no logra capturar audio (Meet cambió su código interno,
// esto corre en un iframe raro, etc.), avisa "no-audio" y content.js cae
// solo al método de siempre (captura de pestaña).
(function () {
  const MARK_EXT = "call-transcriber-ext";
  const MARK_HOOK = "call-transcriber-hook";

  const remoteAudioTracks = new Set();
  let localMicStream = null;
  let mediaRecorder = null;
  let chunks = [];
  let audioContext = null;
  let mixDestination = null;
  let capturing = false;
  let pcHookInstalled = false;
  let gumHookInstalled = false;
  let pcCreatedCount = 0;

  // --- Enganches, deben quedar puestos ANTES de que Meet cree sus conexiones ---
  const OrigRTCPeerConnection = window.RTCPeerConnection;
  if (OrigRTCPeerConnection) {
    function PatchedRTCPeerConnection(...args) {
      pcCreatedCount++;
      const pc = new OrigRTCPeerConnection(...args);
      pc.addEventListener("track", (event) => {
        if (event.track.kind !== "audio") return;
        remoteAudioTracks.add(event.track);
        if (capturing) attachTrack(event.track);
        event.track.addEventListener("ended", () => remoteAudioTracks.delete(event.track));
      });
      return pc;
    }
    PatchedRTCPeerConnection.prototype = OrigRTCPeerConnection.prototype;
    window.RTCPeerConnection = PatchedRTCPeerConnection;
    pcHookInstalled = true;
  }

  if (navigator.mediaDevices?.getUserMedia) {
    const origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async function (constraints) {
      const stream = await origGetUserMedia(constraints);
      if (constraints?.audio && stream.getAudioTracks().length > 0) {
        localMicStream = stream;
      }
      return stream;
    };
    gumHookInstalled = true;
  }

  function attachTrack(track) {
    try {
      const src = audioContext.createMediaStreamSource(new MediaStream([track]));
      src.connect(mixDestination);
    } catch (err) {
      console.warn("[call-transcriber] no se pudo mezclar una pista remota:", err);
    }
  }

  function startCapture() {
    if (capturing) return;
    audioContext = new AudioContext();
    mixDestination = audioContext.createMediaStreamDestination();

    if (localMicStream) {
      audioContext.createMediaStreamSource(localMicStream).connect(mixDestination);
    }
    remoteAudioTracks.forEach(attachTrack);

    const hasAudio = !!localMicStream || remoteAudioTracks.size > 0;
    if (!hasAudio) {
      audioContext.close();
      audioContext = null;
      window.postMessage(
        {
          source: MARK_HOOK,
          type: "no-audio",
          debug: {
            pcHook: pcHookInstalled,
            gumHook: gumHookInstalled,
            pcCreated: pcCreatedCount,
            localMic: !!localMicStream,
            remoteTracks: remoteAudioTracks.size,
          },
        },
        "*"
      );
      return;
    }

    capturing = true;
    chunks = [];
    mediaRecorder = new MediaRecorder(mixDestination.stream, { mimeType: "audio/webm;codecs=opus" });
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    mediaRecorder.start(1000);
    window.postMessage({ source: MARK_HOOK, type: "started" }, "*");
  }

  function stopCapture() {
    if (!capturing || !mediaRecorder) {
      window.postMessage({ source: MARK_HOOK, type: "no-audio" }, "*");
      return;
    }
    mediaRecorder.onstop = () => {
      const blob = new Blob(chunks, { type: "audio/webm" });
      audioContext?.close();
      capturing = false;
      window.postMessage({ source: MARK_HOOK, type: "blob-ready", blob }, "*");
    };
    mediaRecorder.stop();
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== MARK_EXT) return;
    if (event.data.type === "start") startCapture();
    if (event.data.type === "stop") stopCapture();
  });
})();
