import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import ffmpegPath from "ffmpeg-static";
import OpenAI from "openai";

const execFileAsync = promisify(execFile);
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Whisper rechaza archivos de más de 25 MB, y una llamada de más de ~25-35
// minutos grabada con MediaRecorder ya los pasa. Por eso el audio se
// recomprime a mono 48 kbps y se parte en trozos de 15 minutos (~5 MB cada
// uno) antes de mandarlo; la transcripción final es la unión de todos.
const SEGUNDOS_POR_TROZO = 15 * 60;

export async function splitAudio(filePath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "call-transcriber-"));
  const pattern = path.join(dir, "trozo-%03d.mp3");
  await execFileAsync(ffmpegPath, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    filePath,
    // -vn descarta el video cuando "file" es la grabación completa con video.
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "48k",
    "-f",
    "segment",
    "-segment_time",
    String(SEGUNDOS_POR_TROZO),
    "-reset_timestamps",
    "1",
    pattern,
  ]);
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("trozo-"))
    .sort()
    .map((f) => path.join(dir, f));
  if (files.length === 0) throw new Error("ffmpeg no generó ningún trozo de audio");
  return { dir, files };
}

export async function transcribeAudio(filePath) {
  const { dir, files } = await splitAudio(filePath);
  try {
    const partes = [];
    for (const [i, file] of files.entries()) {
      console.log(`[call-transcriber] transcribiendo trozo ${i + 1}/${files.length}…`);
      const params = { file: fs.createReadStream(file), model: "whisper-1", language: "es" };
      // El final del trozo anterior va como contexto para que el corte no
      // rompa la continuidad (nombres propios, tema de la conversación).
      if (partes.length) params.prompt = partes[partes.length - 1].slice(-200);
      const transcription = await client.audio.transcriptions.create(params);
      partes.push(transcription.text.trim());
    }
    return partes.join(" ");
  } finally {
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }
}
