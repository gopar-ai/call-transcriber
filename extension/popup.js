document.getElementById("start").addEventListener("click", async () => {
  const recordVideo = document.getElementById("recordVideo").checked;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const meetingName = encodeURIComponent(tab?.title || "");
  chrome.tabs.create({
    url: chrome.runtime.getURL(`recorder.html?recordVideo=${recordVideo}&meetingName=${meetingName}`),
  });
  window.close();
});
