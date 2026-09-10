import fs from "fs";
import { google } from "googleapis";

function getCredentials() {
  return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
}

function buildDocRequests({ resumen, puntosClave, pendientes, transcript, videoLink, videoPartial }) {
  let cursor = 1;
  let fullText = "";
  const headingRanges = [];
  const boldRanges = [];
  let bulletRange = null;
  let pendientesRange = null;
  let videoLinkRange = null;

  function append(str) {
    const seg = (str || "") + "\n";
    const start = cursor;
    fullText += seg;
    cursor += seg.length;
    return { start, end: cursor - 1 };
  }

  headingRanges.push(append("Resumen ejecutivo"));
  boldRanges.push(append(resumen || "(sin resumen)"));
  append("");

  headingRanges.push(append("Puntos clave"));
  if (puntosClave?.length) {
    const bulletStart = cursor;
    puntosClave.forEach((p) => append(p));
    bulletRange = { start: bulletStart, end: cursor - 1 };
  } else {
    append("(sin puntos clave)");
  }
  append("");

  headingRanges.push(append("Pendientes"));
  if (pendientes?.length) {
    const pendStart = cursor;
    pendientes.forEach((p) => append(p));
    pendientesRange = { start: pendStart, end: cursor - 1 };
  } else {
    append("(sin pendientes)");
  }
  append("");

  if (videoLink) {
    videoLinkRange = append(videoPartial ? "🎥 Ver grabación en video (parcial, desde que se activó)" : "🎥 Ver grabación en video");
    append("");
  }

  headingRanges.push(append("Transcripción completa"));
  append(transcript);

  const requests = [{ insertText: { location: { index: 1 }, text: fullText } }];

  headingRanges.forEach(({ start, end }) => {
    requests.push({
      updateParagraphStyle: {
        range: { startIndex: start, endIndex: end },
        paragraphStyle: { namedStyleType: "HEADING_1" },
        fields: "namedStyleType",
      },
    });
  });

  boldRanges.forEach(({ start, end }) => {
    requests.push({
      updateTextStyle: {
        range: { startIndex: start, endIndex: end },
        textStyle: { bold: true },
        fields: "bold",
      },
    });
  });

  if (bulletRange) {
    requests.push({
      createParagraphBullets: {
        range: { startIndex: bulletRange.start, endIndex: bulletRange.end },
        bulletPreset: "BULLET_DISC_CIRCLE_SQUARE",
      },
    });
  }
  if (pendientesRange) {
    requests.push({
      createParagraphBullets: {
        range: { startIndex: pendientesRange.start, endIndex: pendientesRange.end },
        bulletPreset: "BULLET_CHECKBOX",
      },
    });
  }
  if (videoLinkRange) {
    requests.push({
      updateTextStyle: {
        range: { startIndex: videoLinkRange.start, endIndex: videoLinkRange.end },
        textStyle: { bold: true, link: { url: videoLink } },
        fields: "bold,link",
      },
    });
  }

  return requests;
}

export async function uploadVideoToDrive(filePath, filename, folderId) {
  const auth = new google.auth.GoogleAuth({
    credentials: getCredentials(),
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
  const drive = google.drive({ version: "v3", auth });

  const res = await drive.files.create({
    requestBody: { name: filename, parents: [folderId] },
    media: { mimeType: "video/webm", body: fs.createReadStream(filePath) },
    fields: "id, webViewLink",
    supportsAllDrives: true,
  });

  return res.data.webViewLink;
}

export async function createCallDoc({ title, resumen, puntosClave, pendientes, transcript, videoLink, videoPartial, folderId }) {
  const auth = new google.auth.GoogleAuth({
    credentials: getCredentials(),
    scopes: [
      "https://www.googleapis.com/auth/documents",
      "https://www.googleapis.com/auth/drive",
    ],
  });
  const docs = google.docs({ version: "v1", auth });
  const drive = google.drive({ version: "v3", auth });

  // Se crea directo dentro de la carpeta compartida (vía Drive API, no
  // Docs API) para que quede con la cuota de esa carpeta, no la del service
  // account — los service accounts no tienen espacio propio en Drive.
  const createRes = await drive.files.create({
    requestBody: {
      name: title,
      mimeType: "application/vnd.google-apps.document",
      parents: [folderId],
    },
    fields: "id",
    supportsAllDrives: true,
  });
  const documentId = createRes.data.id;

  const requests = buildDocRequests({ resumen, puntosClave, pendientes, transcript, videoLink, videoPartial });
  await docs.documents.batchUpdate({ documentId, requestBody: { requests } });

  return `https://docs.google.com/document/d/${documentId}/edit`;
}
