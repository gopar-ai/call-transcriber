chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.action === "open-recorder") {
    const meetTabId = sender.tab?.id;

    const openWith = (streamId, tcError) => {
      const url = chrome.runtime.getURL(
        `recorder.html?recordVideo=${message.recordVideo}&meetingName=${message.meetingName || ""}&destination=${message.destination || "work"}${
          streamId ? `&streamId=${streamId}` : ""
        }${tcError ? `&tcError=${encodeURIComponent(tcError)}` : ""}${
          message.webrtcReason ? `&webrtcReason=${encodeURIComponent(message.webrtcReason)}` : ""
        }`
      );
      chrome.tabs.create({ url }, (tab) => {
        chrome.storage.local.set({
          activeRecording: { recorderTabId: tab.id, meetTabId },
        });
      });
    };

    // Se intenta capturar la pestaña directo, sin selector de Chrome (así no
    // "gasta" el compartir pantalla y no choca con "Presentar" en Meet). Si
    // no se puede obtener el streamId, recorder.js cae solo al selector normal
    // — el motivo exacto se le pasa para que se vea en pantalla, sin DevTools.
    if (meetTabId != null) {
      chrome.tabCapture.getMediaStreamId({ targetTabId: meetTabId }, (streamId) => {
        const err = chrome.runtime.lastError;
        console.log("[call-transcriber] tabCapture.getMediaStreamId:", { streamId, err: err?.message });
        openWith(err ? null : streamId, err?.message);
      });
    } else {
      openWith(null, "no se pudo identificar la pestaña de la llamada (sender.tab vacío)");
    }
    return;
  }

  // La pestaña de grabación reporta su estado; se lo reenviamos a la
  // pestaña de la llamada para que el botón flotante refleje lo que pasa.
  if (["recording-confirmed", "recording-failed", "recording-done"].includes(message.action)) {
    chrome.storage.local.get("activeRecording", ({ activeRecording }) => {
      if (!activeRecording?.meetTabId) return;
      chrome.tabs
        .sendMessage(activeRecording.meetTabId, {
          action: "recorder-status",
          status: message.action,
          docUrl: message.docUrl,
        })
        .catch(() => {});
      if (message.action !== "recording-confirmed") {
        chrome.storage.local.remove("activeRecording");
      }
    });
    return;
  }

  // El botón "Detener" (o "+ Video") del widget flotante en la llamada le
  // avisa a la pestaña de grabación (que puede estar en otra pestaña/ventana).
  if (message.action === "request-stop" || message.action === "enable-video-now") {
    const forwardAction = message.action === "request-stop" ? "trigger-stop" : "enable-video-now";
    chrome.storage.local.get("activeRecording", ({ activeRecording }) => {
      if (!activeRecording?.recorderTabId) return;
      chrome.tabs.sendMessage(activeRecording.recorderTabId, { action: forwardAction }).catch(() => {});
    });
    return;
  }
});
