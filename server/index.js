import "dotenv/config";
import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import os from "os";
import { transcribeAudio } from "./lib/transcribe.js";
import { summarizeCall } from "./lib/summarize.js";
import { createCallDoc, uploadVideoToDrive } from "./lib/drive.js";

const app = express();
app.use(cors());

// Whisper detecta el formato por la extensión del archivo, por eso se fuerza
// .webm en el nombre del temporal (multer por default no le pone extensión).
const storage = multer.diskStorage({
  destination: os.tmpdir(),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}.webm`),
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

const FOLDERS_BY_DESTINATION = {
  work: process.env.DRIVE_FOLDER_ID,
  personal: process.env.DRIVE_FOLDER_ID_PERSONAL,
};

app.get("/", (req, res) => res.send("call-transcriber server OK"));

app.post(
  "/calls",
  upload.fields([
    { name: "file", maxCount: 1 },
    { name: "videoFile", maxCount: 1 },
  ]),
  async (req, res) => {
    const tempPath = req.files?.file?.[0]?.path;
    const videoTempPath = req.files?.videoFile?.[0]?.path;
    try {
      if (!tempPath) {
        return res.status(400).json({ ok: false, error: "Falta el archivo (campo 'file')" });
      }
      const destination = req.body.destination === "personal" ? "personal" : "work";
      const folderId = FOLDERS_BY_DESTINATION[destination];
      if (!folderId) throw new Error(`Falta la variable de entorno de carpeta para el destino "${destination}"`);

      const recordVideo = req.body.recordVideo === "true";
      const videoPartial = req.body.videoPartial === "true";
      const meetingName = (req.body.meetingName || "").trim();

      console.log("[call-transcriber] transcribiendo…");
      const transcript = await transcribeAudio(tempPath);

      console.log("[call-transcriber] resumiendo con GPT-4o-mini…");
      const { resumen, puntos_clave: puntosClave, pendientes } = await summarizeCall(transcript);

      let videoLink = null;
      // Si el video se activó a medio de la llamada, viene en su propio
      // archivo (videoFile); si se activó desde el inicio, "file" ya es el
      // video completo.
      const videoSourcePath = videoTempPath || (recordVideo ? tempPath : null);
      if (videoSourcePath) {
        console.log("[call-transcriber] subiendo video a Drive…");
        const filename = `llamada-video-${new Date().toISOString().replace(/[:.]/g, "-")}.webm`;
        videoLink = await uploadVideoToDrive(videoSourcePath, filename, folderId);
      }

      console.log("[call-transcriber] creando Google Doc…");
      // "es-MX" solo cambia el idioma/formato, no el huso horario — el server
      // corre en UTC (Railway), por eso hay que fijar la zona explícitamente.
      const now = new Date();
      const fecha = now.toLocaleDateString("es-MX", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: "America/Mexico_City",
      });
      const hora = now.toLocaleTimeString("es-MX", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "America/Mexico_City",
      });
      const nombre = meetingName && !/^meet($|\s)/i.test(meetingName) ? meetingName : "Llamada";
      const title = `🎙️ ${nombre} — ${fecha}, ${hora} / Notas Jan`;

      const docUrl = await createCallDoc({
        title,
        resumen,
        puntosClave,
        pendientes,
        transcript,
        videoLink,
        videoPartial,
        folderId,
      });

      console.log("[call-transcriber] listo:", docUrl);
      res.json({ ok: true, docUrl, videoLink });
    } catch (err) {
      console.error("[call-transcriber] error:", err);
      res.status(500).json({ ok: false, error: String(err.message || err) });
    } finally {
      [tempPath, videoTempPath].forEach((p) => p && fs.unlink(p, () => {}));
    }
  }
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`call-transcriber server escuchando en :${PORT}`));
