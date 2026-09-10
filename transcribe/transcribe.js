import "dotenv/config";
import fs from "fs";
import OpenAI from "openai";

const filePath = process.argv[2];
if (!filePath) {
  console.error("Uso: node transcribe.js <ruta-al-audio.webm>");
  process.exit(1);
}
if (!fs.existsSync(filePath)) {
  console.error(`No existe el archivo: ${filePath}`);
  process.exit(1);
}
if (!process.env.OPENAI_API_KEY) {
  console.error("Falta OPENAI_API_KEY (copia .env.example a .env y agrega tu key)");
  process.exit(1);
}

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

console.log("Transcribiendo…");
const transcription = await client.audio.transcriptions.create({
  file: fs.createReadStream(filePath),
  model: "whisper-1",
  language: "es",
});

console.log("\n--- Transcripción ---\n");
console.log(transcription.text);

const outPath = filePath.replace(/\.[^.]+$/, "") + ".txt";
fs.writeFileSync(outPath, transcription.text, "utf-8");
console.log(`\nGuardado en: ${outPath}`);
