import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { csvRowForPatient } from "./csv.js";
import { HttpError } from "./errors.js";
import { exportPdf, findMeasurement, linkMeasurement, listSummaries } from "./measurement.js";
import { createPatient, type NewPatient } from "./patient.js";
import type { Session } from "./session.js";

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64 * 1024) throw new HttpError(413, "request body too large");
    chunks.push(c as Buffer);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {}
  throw new HttpError(400, "body must be a JSON object");
}

export function createApiServer(s: Session): Server {
  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const key = `${req.method} /${parts.map((p, i) => (i === 1 ? ":id" : p)).join("/")}`;

    switch (key) {
      case "POST /patients": {
        const created = await createPatient(s, (await readJson(req)) as unknown as NewPatient);
        return json(res, 201, created);
      }
      case "GET /measurements":
        return json(res, 200, await listSummaries(s));
      case "POST /measurements/:id/link": {
        const { externalPatientId } = await readJson(req);
        if (typeof externalPatientId !== "string" || !externalPatientId) throw new HttpError(400, "externalPatientId is required");
        const m = await linkMeasurement(s, externalPatientId, parts[1]);
        return json(res, 200, { measurementId: parts[1], externalPatientId: m.patient.externalPatientId });
      }
      case "GET /patients/:id/csv":
        return json(res, 200, await csvRowForPatient(s, parts[1]!));
      case "GET /measurements/:id/pdf": {
        const { pdf } = await exportPdf(s, await findMeasurement(s, parts[1]!));
        res.writeHead(200, { "content-type": "application/pdf", "content-length": pdf.length });
        return void res.end(pdf);
      }
      default:
        throw new HttpError(404, `no route for ${req.method} ${url.pathname}`);
    }
  }

  return createServer((req, res) => {
    route(req, res).catch((e: unknown) => {
      if (res.headersSent) return void res.destroy();
      if (e instanceof HttpError) return json(res, e.status, { error: e.message });
      console.error(e);
      json(res, 502, { error: e instanceof Error ? e.message : String(e) }); // upstream (secacloud) failure
    });
  });
}
