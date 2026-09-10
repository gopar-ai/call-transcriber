import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function summarizeCall(transcript) {
  const completion = await client.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "user",
        content: `Eres un asistente que convierte transcripciones de llamadas de trabajo (ventas, seguimiento con clientes, internas) en notas útiles para el equipo, en español, estilo notas automáticas de Google Meet.

Responde SOLO con un objeto JSON válido con exactamente esta forma:
{"resumen": "3-4 líneas de resumen ejecutivo de la llamada", "puntos_clave": ["punto 1", "punto 2"], "pendientes": ["pendiente o siguiente paso 1"]}

Si no hay pendientes claros, regresa "pendientes": [].

Transcripción:
${transcript}`,
      },
    ],
  });

  return JSON.parse(completion.choices[0].message.content);
}
