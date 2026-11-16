import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { api, apiJson } from "./api.js";
import { HttpError } from "./errors.js";
import { findPatient } from "./patient.js";
import type { Session } from "./session.js";

const ZERO_GUID = "00000000-0000-0000-0000-000000000000";
// Taken from the spec's captured request; the "global" template is account-independent.
const CHART_TEMPLATE_ID = "b0a5d072-5917-4f5d-ae20-5fcfdf578444";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Measurement {
  id: string;
  originalMeasurementId: string;
  measurementDate: string;
  patient: { id: string; externalPatientId: string | null };
}

export async function listMeasurements(s: Session, take = 30): Promise<Measurement[]> {
  const r = await apiJson<{ measurementDetailsList: Measurement[] }>(
    s,
    `/api/analytics/v1/measurement?sortBy=measurementDate&take=${take}&ascending=false&isDeleted=false`,
  );
  return r.measurementDetailsList;
}

/** Public list item: `measurementId` is the upstream `originalMeasurementId`, the date is unix seconds. */
export interface MeasurementSummary {
  measurementId: string;
  measurementDate: number;
  externalPatientId: string | null;
}

export async function listSummaries(s: Session): Promise<MeasurementSummary[]> {
  return (await listMeasurements(s, 30)).map((m) => ({
    measurementId: m.originalMeasurementId,
    measurementDate: Math.floor(Date.parse(m.measurementDate) / 1000),
    externalPatientId: m.patient.externalPatientId,
  }));
}

/** Find a measurement by its public id (upstream `originalMeasurementId`), paging back through history. */
export async function findMeasurement(s: Session, measurementId: string): Promise<Measurement> {
  const base = "/api/analytics/v1/measurement?sortBy=measurementDate&take=100&ascending=false&isDeleted=false";
  let next = "";
  for (let page = 0; page < 100; page++) {
    const r = await apiJson<{
      nextItemId: string | null;
      nextSortValue: string | null;
      hasMoreData: boolean;
      measurementDetailsList: Measurement[];
    }>(s, base + next);
    const m = r.measurementDetailsList.find((x) => x.originalMeasurementId === measurementId);
    if (m) return m;
    if (!r.hasMoreData || !r.nextItemId) break;
    next = `&nextItemId=${r.nextItemId}&nextSortValue=${encodeURIComponent(r.nextSortValue ?? "")}`;
  }
  throw new HttpError(404, `No measurement ${measurementId}`);
}

/** What exportPdf needs from a measurement. */
export type MeasurementRef = Pick<Measurement, "id"> & { patient: Pick<Measurement["patient"], "id" | "externalPatientId"> };

interface AdditionalData {
  measurements: {
    height: { value: number | null; unit: string } | null;
    waistCircumference: { value: number | null; unit: string } | null;
    weight: { value: number | null; unit: string } | null;
  };
  patientId: string;
  pal: { value: number | null; workActivityLevel: unknown; leisureActivityLevel: unknown };
  comment: string;
}

/**
 * Link a measurement to the patient with this IDP. Mode "api" (default) uses HTTP, mode "ui" simulates clicks.
 * With `measurementId` (the public id, i.e. the upstream `originalMeasurementId`) it links exactly that measurement
 * (use this when several people measure at the same time), and refuses (409) one that already belongs to a different
 * patient. Without it, it links the newest unlinked one among the latest 30. "ui" mode only supports the latter.
 */
export async function linkMeasurement(s: Session, idp: string, measurementId?: string): Promise<MeasurementRef> {
  if (s.cfg.mode === "ui") {
    if (measurementId) throw new HttpError(501, "ui mode can only link the newest unlinked measurement; use api mode to link a specific one");
    return linkViaUi(s, idp);
  }
  return linkViaApi(s, idp, measurementId);
}

/** HTTP flow, captured from the app: find the patient, read the measurement's current data, POST it back with the new patientId. */
async function linkViaApi(s: Session, idp: string, measurementId?: string): Promise<MeasurementRef> {
  const patient = await findPatient(s, idp);
  let target: Measurement | undefined;
  if (measurementId) {
    target = await findMeasurement(s, measurementId);
    const ref = { id: target.id, patient: { id: patient.id, externalPatientId: idp } };
    if (target.patient.id === patient.id) return ref; // already linked to this patient: nothing to do
    if (target.patient.id !== ZERO_GUID) {
      throw new HttpError(409, `measurement already belongs to ${target.patient.externalPatientId}; not re-assigning`);
    }
  } else {
    target = (await listMeasurements(s)).find((m) => m.patient.id === ZERO_GUID);
  }
  if (!target) throw new HttpError(404, "No unlinked measurement found");
  const id = target.id;

  const path = `/api/analytics/v1/measurement/additional-data/${id}`;
  const cur = await apiJson<AdditionalData>(s, path);
  const { height, waistCircumference, weight } = cur.measurements;
  await api(s, path, {
    method: "POST",
    body: JSON.stringify({
      patientId: patient.id,
      measurements: {
        // Unverified for a never-linked measurement: the app sent the patient's reference height there.
        height: height?.value != null ? height : patient.height,
        waistCircumference: waistCircumference?.value != null ? waistCircumference : null,
        weight,
      },
      pal: { value: cur.pal.value, workActivityLevel: cur.pal.workActivityLevel, leisureActivityLevel: cur.pal.leisureActivityLevel },
      comment: cur.comment ?? "",
    }),
  });

  const after = await apiJson<AdditionalData>(s, path);
  if (after.patientId !== patient.id) throw new Error(`Link to ${idp} was not applied to measurement ${id}`);
  return { id, patient: { id: patient.id, externalPatientId: idp } };
}

/** UI flow: link the newest unlinked measurement via simulated clicks. */
async function linkViaUi(s: Session, idp: string): Promise<MeasurementRef> {
  const target = (await listMeasurements(s)).find((m) => m.patient.id === ZERO_GUID);
  if (!target) throw new Error("No unlinked measurement found");

  const page = await s.newPage();
  try {
    await page.goto(`https://${s.cfg.host}/${s.cfg.tenant}/measurements`, { waitUntil: "networkidle2" });
    await sleep(2000); // the list renders after the network goes idle
    // The page is a card list (newest first, same order as the API); unlinked cards show "No name".
    // Flow verified live: card -> "Edit measurement data" -> Select existing patient -> type IDP -> Assign -> Save -> Proceed.
    await page.locator("::-p-text(No name)").click();
    await page.locator("::-p-text(Edit measurement data)").wait();
    await sleep(1500); // let the dialog animation settle, otherwise the click misses the moving button
    await page.locator("button::-p-text(Select existing patient)").click();
    await page.locator("::-p-text(Check patient data)").wait();
    await sleep(1000);
    await page.keyboard.type(idp);
    await page.locator("button::-p-text(Assign)").click(); // appears once the search finds the IDP
    await page.locator("button::-p-text(Save)").click(); // Assign only fills the dialog
    await page.locator("button::-p-text(Proceed)").click(); // "Confirm change" dialog; this one persists it
  } finally {
    await page.close();
  }

  for (let i = 0; i < 20; i++) {
    const m = (await listMeasurements(s)).find((x) => x.id === target.id);
    if (m && m.patient.id !== ZERO_GUID) return m;
    await sleep(1500);
  }
  throw new Error(`Measurement ${target.id} was not linked to ${idp} within 30s`);
}

/** Generate the PDF of a linked measurement; saves it to SECA_OUT_PDF_DIR and returns the path and the bytes. */
export async function exportPdf(s: Session, m: MeasurementRef): Promise<{ file: string; pdf: Buffer }> {
  if (m.patient.id === ZERO_GUID) throw new HttpError(409, "measurement is not linked to a patient; the PDF needs one");
  const id = m.id; // verified: the spec's PDF request uses `id`, while UI URLs use `originalMeasurementId`
  const put = await apiJson<Record<string, unknown>>(s, `/api/analytics/v1/measurement/${id}/pdf/exportByIds`, {
    method: "PUT",
    body: JSON.stringify({
      pdfTemplates: "SingleView",
      chartTemplateId: CHART_TEMPLATE_ID,
      isChartTemplateGlobal: true,
      locale: "En",
      languageType: "Medical",
      dateLocale: "zh-SG",
      dateTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      patientId: m.patient.id,
      measurementIds: [id],
    }),
  });
  const exportId = (put.pdfExportId ?? (put.measurementPdfStatus as any)?.pdfExportId) as string | undefined;
  if (!exportId) throw new Error(`exportByIds returned no pdfExportId: ${JSON.stringify(put)}`);

  for (let i = 0; i < 60; i++) {
    const st = await apiJson<{ measurementPdfStatus: { status: string } }>(
      s,
      `/api/analytics/v1/measurement/pdf/${exportId}/status`,
    );
    if (st.measurementPdfStatus.status === "Finished") break;
    if (i === 59) throw new Error("PDF generation timed out");
    await sleep(2000);
  }

  const pdf = Buffer.from(await (await api(s, `/api/analytics/v1/measurement/pdf/${exportId}`)).arrayBuffer());
  await mkdir(s.cfg.pdfDir, { recursive: true });
  const file = join(s.cfg.pdfDir, `${m.patient.externalPatientId ?? id}_${id}.pdf`);
  await writeFile(file, pdf);
  return { file, pdf };
}
