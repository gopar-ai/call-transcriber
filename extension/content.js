(function () {
  if (document.getElementById("call-transcriber-widget")) return;

  // Cambia esto por la URL de tu propio backend desplegado (ver server/README).
  const SERVER_URL = "https://your-backend.up.railway.app";
  const MARK_EXT = "call-transcriber-ext";
  const MARK_HOOK = "call-transcriber-hook";

  function mount() {
    if (document.getElementById("call-transcriber-widget") || !document.body) return;

    const widget = document.createElement("div");
    widget.id = "call-transcriber-widget";
    document.body.appendChild(widget);

    const logoUrl = chrome.runtime.getURL("icons/icon32.png");
    let recordVideoActive = false;
    let destinationActive = "work";
    let stopHangupWatcher = null;
    let usingWebRtc = false;

    // Detecta que colgaste/saliste de la llamada (los controles de Meet ya
    // no están en la página) y detiene la grabación sola, sin que tengas
    // que acordarte de darle "Detener" tú misma.
    function watchForHangup(onHangup) {
      let misses = 0;
      const interval = setInterval(() => {
        const inCall = !!document.querySelector(
          '[aria-label*="Salir de la llamada" i], [aria-label*="Abandonar la llamada" i], ' +
            '[aria-label*="Leave call" i], [aria-label*="micrófono" i], [aria-label*="microphone" i]'
        );
        if (inCall) {
          misses = 0;
          return;
        }
        misses++;
        if (misses >= 3) {
          clearInterval(interval);
          onHangup();
        }
      }, 2000);
      return () => clearInterval(interval);
    }

    // --- posición: recordada entre llamadas, arrastrable con el grip ---
    chrome.storage.local.get("widgetPosition", ({ widgetPosition }) => {
      if (widgetPosition) applyPosition(widgetPosition);
    });

    function applyPosition(pos) {
      widget.style.left = pos.left + "px";
      widget.style.top = pos.top + "px";
      widget.style.right = "auto";
      widget.style.bottom = "auto";
    }

    function makeDraggable(grip) {
      let dragging = false;
      let offsetX = 0;
      let offsetY = 0;

      grip.addEventListener("pointerdown", (e) => {
        dragging = true;
        const rect = widget.getBoundingClientRect();
        offsetX = e.clientX - rect.left;
        offsetY = e.clientY - rect.top;
        grip.setPointerCapture(e.pointerId);
      });

      grip.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const left = Math.min(Math.max(0, e.clientX - offsetX), window.innerWidth - widget.offsetWidth);
        const top = Math.min(Math.max(0, e.clientY - offsetY), window.innerHeight - widget.offsetHeight);
        applyPosition({ left, top });
      });

      grip.addEventListener("pointerup", () => {
        if (!dragging) return;
        dragging = false;
        const rect = widget.getBoundingClientRect();
        chrome.storage.local.set({ widgetPosition: { left: rect.left, top: rect.top } });
      });
    }

    function renderIdle() {
      widget.innerHTML = `
        <div class="ct-box">
          <span class="ct-grip" title="Arrastra para mover">⠿</span>
          <img class="ct-logo" src="${logoUrl}" alt="" />
          <span class="ct-dot"></span>
          <button id="ct-start">Transcribir llamada</button>
          <label class="ct-toggle" title="Guardar también el video en Drive">
            <input type="checkbox" id="ct-record-video" />
            <span class="ct-toggle-track"><span class="ct-toggle-thumb"></span></span>
            <span class="ct-toggle-label">Video</span>
          </label>
          <div class="ct-dest" title="A qué Drive se guarda esta llamada">
            <button class="ct-dest-btn ${destinationActive === "work" ? "ct-dest-active" : ""}" data-dest="work">WORK</button>
            <button class="ct-dest-btn ${destinationActive === "personal" ? "ct-dest-active" : ""}" data-dest="personal">PERS</button>
          </div>
          <button class="ct-dismiss" id="ct-dismiss" title="No transcribir esta llamada">✕</button>
        </div>
        <div class="ct-signature">⚡ by Jan</div>
      `;

      makeDraggable(widget.querySelector(".ct-grip"));

      widget.querySelectorAll(".ct-dest-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          destinationActive = btn.dataset.dest;
          widget.querySelectorAll(".ct-dest-btn").forEach((b) => b.classList.toggle("ct-dest-active", b === btn));
        });
      });

      document.getElementById("ct-start").addEventListener("click", () => {
        recordVideoActive = document.getElementById("ct-record-video").checked;
        // El título de la pestaña de Meet suele traer el nombre del evento del
        // calendario cuando la llamada viene de una invitación — si no, cae a
        // un genérico en el backend.
        const meetingName = encodeURIComponent(document.title.replace(/\s*-\s*Google Meet\s*$/i, "").trim());
        renderPending();

        if (recordVideoActive) {
          // Con video: usa el método de siempre (captura de pestaña) — el
          // método sin captura solo soporta audio por ahora.
          openTabCaptureFlow(meetingName);
        } else {
          tryWebRtcCapture(meetingName);
        }
      });

      document.getElementById("ct-dismiss").addEventListener("click", () => widget.remove());
    }

    function openTabCaptureFlow(meetingName, webrtcReason) {
      usingWebRtc = false;
      chrome.runtime.sendMessage({
        action: "open-recorder",
        recordVideo: recordVideoActive,
        meetingName,
        destination: destinationActive,
        webrtcReason: webrtcReason || "",
      });
    }

    function tryWebRtcCapture(meetingName) {
      let settled = false;

      function onWindowMessage(event) {
        if (event.source !== window || event.data?.source !== MARK_HOOK) return;
        if (event.data.type === "started") {
          settled = true;
          window.removeEventListener("message", onWindowMessage);
          usingWebRtc = true;
          renderActive();
        } else if (event.data.type === "no-audio") {
          settled = true;
          window.removeEventListener("message", onWindowMessage);
          const d = event.data.debug || {};
          openTabCaptureFlow(
            meetingName,
            `no-audio: pcHook=${d.pcHook} gumHook=${d.gumHook} pcCreated=${d.pcCreated} localMic=${d.localMic} remoteTracks=${d.remoteTracks}`
          );
        }
      }

      window.addEventListener("message", onWindowMessage);
      window.postMessage({ source: MARK_EXT, type: "start" }, "*");

      // Si el enganche a Meet no responde nada en unos segundos, se asume
      // que no funcionó (Meet cambió algo, iframe raro, etc.) y se cae al
      // método de siempre — nunca se queda sin poder grabar.
      setTimeout(() => {
        if (!settled) {
          window.removeEventListener("message", onWindowMessage);
          openTabCaptureFlow(meetingName, "timeout: webrtc-hook.js nunca respondió en 3s");
        }
      }, 3000);
    }

    async function uploadAudioBlob(blob, meetingName) {
      try {
        const formData = new FormData();
        formData.append("file", blob, "llamada.webm");
        formData.append("recordVideo", "false");
        formData.append("meetingName", meetingName);
        formData.append("destination", destinationActive);

        const res = await fetch(`${SERVER_URL}/calls`, { method: "POST", body: formData });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "El servidor regresó un error");

        window.open(data.docUrl, "_blank");
      } catch (err) {
        console.error("[call-transcriber] error subiendo (modo sin captura):", err);
        alert("Call Transcriber: no se pudo subir la grabación (" + err.message + "). Revisa tu conexión.");
      } finally {
        widget.remove();
      }
    }

    function renderPending() {
      widget.innerHTML = `
        <div class="ct-box">
          <span class="ct-grip" title="Arrastra para mover">⠿</span>
          <img class="ct-logo" src="${logoUrl}" alt="" />
          <span class="ct-dot"></span>
          <span class="ct-text">Iniciando…</span>
        </div>
      `;
      makeDraggable(widget.querySelector(".ct-grip"));
    }

    function renderActive() {
      // Mensaje explícito de qué está pasando exactamente, para que no haya
      // duda de si se está grabando video, transcribiendo, o ambas cosas.
      const destLabel = destinationActive === "personal" ? "Personal" : "Work";
      const label = recordVideoActive
        ? `🔴 Grabando video y transcribiendo (→ ${destLabel})`
        : `🎙️ Transcribiendo esta llamada (→ ${destLabel})`;
      const videoBtn = recordVideoActive
        ? ""
        : `<button id="ct-add-video" title="Empieza a grabar video desde este momento">+ Video</button>`;
      widget.innerHTML = `
        <div class="ct-box">
          <span class="ct-grip" title="Arrastra para mover">⠿</span>
          <img class="ct-logo" src="${logoUrl}" alt="" />
          <span class="ct-dot"></span>
          <span class="ct-text">${label}</span>
          ${videoBtn}
          <button id="ct-stop" title="Detiene la grabación sin salir de la llamada">⏹ Detener</button>
        </div>
        <div class="ct-signature">⚡ by Jan</div>
      `;
      makeDraggable(widget.querySelector(".ct-grip"));

      document.getElementById("ct-add-video")?.addEventListener("click", () => {
        if (usingWebRtc) {
          // El modo sin captura es solo audio; para sumar video hay que
          // abrir el método de siempre (captura de pestaña) aparte.
          alert(
            'Para agregar video hay que usar el modo con selector. Detén esta grabación y vuelve a iniciar con "Video" activado.'
          );
          return;
        }
        chrome.runtime.sendMessage({ action: "enable-video-now" });
        recordVideoActive = true;
        renderActive();
      });

      document.getElementById("ct-stop").addEventListener("click", () => {
        stopHangupWatcher?.();
        if (usingWebRtc) {
          window.postMessage({ source: MARK_EXT, type: "stop" }, "*");
        } else {
          chrome.runtime.sendMessage({ action: "request-stop" });
        }
        widget.innerHTML = `<div class="ct-box"><img class="ct-logo" src="${logoUrl}" alt="" /><span class="ct-text">Guardando…</span></div>`;
      });

      // Cada vez que se re-renderiza el estado activo (ej. al activar video)
      // se reinicia el watcher para no duplicarlo.
      stopHangupWatcher?.();
      stopHangupWatcher = watchForHangup(() => {
        if (usingWebRtc) {
          window.postMessage({ source: MARK_EXT, type: "stop" }, "*");
        } else {
          chrome.runtime.sendMessage({ action: "request-stop" });
        }
        widget.innerHTML = `<div class="ct-box"><img class="ct-logo" src="${logoUrl}" alt="" /><span class="ct-text">Llamada terminada — guardando…</span></div>`;
      });
    }

    // Respuestas del enganche a Meet (modo sin captura de pestaña).
    window.addEventListener("message", (event) => {
      if (event.source !== window || event.data?.source !== MARK_HOOK) return;
      if (event.data.type === "blob-ready") {
        const meetingName = encodeURIComponent(document.title.replace(/\s*-\s*Google Meet\s*$/i, "").trim());
        uploadAudioBlob(event.data.blob, meetingName);
      }
    });

    // Estado que llega de la pestaña de grabación (modo con captura de
    // pestaña, vía background.js).
    chrome.runtime.onMessage.addListener((message) => {
      if (message.action !== "recorder-status") return;
      if (message.status === "recording-confirmed") renderActive();
      if (message.status === "recording-failed" || message.status === "recording-done") {
        stopHangupWatcher?.();
        widget.remove();
      }
    });

    renderIdle();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
