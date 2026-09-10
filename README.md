# call-transcriber

A Chrome extension that detects when you join a Google Meet call, transcribes
it automatically with Whisper, generates structured notes with GPT-4o-mini
(executive summary, key points, action items as real checkboxes), and creates
a Google Doc per call — with **zero manual steps** and, in the common case,
**without ever touching the screen-sharing APIs**, so presenting your screen
in the same call never conflicts with recording.

## Why this exists

Most browser-based call recorders (and the naive way to build one) capture
audio via `getDisplayMedia()` — the "choose what to share" picker. That works,
but it has a real cost: once a tab is being captured that way, you can't also
use the meeting platform's own "present screen" feature in the same tab
without a conflict. For someone who presents on calls regularly, that's a
dealbreaker.

The fix: Google Meet is a WebRTC application, so the call's audio already
flows through `RTCPeerConnection` objects inside the page's own JavaScript
before it ever reaches your speakers. A `MAIN`-world content script (injected
at `document_start`, before Meet's own code runs) patches `RTCPeerConnection`
and `getUserMedia` to read those audio tracks directly — your mic and every
participant's audio — mixes them with the Web Audio API, and records with
`MediaRecorder`. No screen/tab capture involved at all, so it never competes
with presenting.

Video is the one case that still needs screen/tab capture (there's no way
around reading pixels without some form of capture), so it's opt-in and uses
a fallback chain instead: try `chrome.tabCapture` (no picker shown) first,
and only fall back to the `getDisplayMedia` picker if that's unavailable.

## Architecture

```
extension/
  content.js       – floating widget injected into Meet, ISOLATED world
  webrtc-hook.js    – patches RTCPeerConnection/getUserMedia, MAIN world
  background.js     – service worker: opens the fallback capture tab,
                       relays start/stop/status between contexts
  recorder.html/js  – fallback capture flow (tabCapture → getDisplayMedia),
                       used only when video is requested or the WebRTC hook
                       can't attach
  popup.html/js     – manual entry point outside of Meet

server/
  index.js          – Express endpoint that receives the audio (+ optional
                       video), transcribes, summarizes, creates the Doc
  lib/transcribe.js – Whisper
  lib/summarize.js  – GPT-4o-mini, structured JSON output
  lib/drive.js      – Docs/Drive API: creates the Doc with real formatting
                       (headings, bullets, a real checkbox list, a hyperlink)
                       via batchUpdate index math, and uploads the video
```

## Setup

**Extension**
1. `chrome://extensions` → enable Developer mode → "Load unpacked" → select `extension/`
2. Edit the `SERVER_URL` constant in `extension/content.js` and
   `extension/recorder.js` to point at your own deployed backend.

**Backend**
```
cd server
npm install
cp .env.example .env
npm start
```

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY` | Whisper (transcription) + GPT-4o-mini (summary) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Service account credentials, full JSON as one line |
| `DRIVE_FOLDER_ID` | Where Docs land for the default ("work") destination |
| `DRIVE_FOLDER_ID_PERSONAL` | Optional second destination — the extension has a small "WORK / PERS" switch in the widget to route calls to different Drives (e.g. a work account vs. a personal one) |

**Important Google Drive detail**: service accounts have no personal storage
quota — creating a file directly in a regular "My Drive" folder fails with
`storageQuotaExceeded`, even if the folder is shared with the service account
as an editor. The target folder has to live inside a **Shared Drive**, where
storage is billed to the organization rather than to whoever created the
file. `drive.files.create` also needs `supportsAllDrives: true` explicitly.

## Notes

- Multiple people can transcribe on the same Meet call independently — nothing
  server-side is scoped to a specific user, each browser just uploads to
  whatever backend/destination it's configured with.
- If the upload fails (offline, backend down), the recording downloads
  locally instead of being lost.
- The floating widget is draggable, remembers its position, shows explicit
  status text ("Transcribing" vs "Recording video and transcribing") so
  there's never ambiguity about what's actually happening, and detects when
  you've left the call (via Meet's own DOM) to stop and save automatically.
