import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { api, apiJson } from "./api.js";
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

/** Link the newest unlinked measurement to an existing patient via the UI (no stable HTTP flow known). */
export async function linkLatest(s: Session, idp: string): Promise<Measurement> {
  const list = await listMeasurements(s);
  const target = list.find((m) => m.patient.id === ZERO_GUID);
  if (!target) throw new Error("No unlinked measurement found");
  if (list[0]?.id !== target.id) throw new Error("Unlinked measurement is not the newest row; refusing to click blindly");

  const { page } = s;
  await page.goto(`https://${s.cfg.host}/${s.cfg.tenant}/measurements`);
  // Selectors/text are assumed from the spec; verify against the live page.
  await page.locator("table tbody tr").click();
  await page.locator("::-p-text(Select existing patient)").click();
  await page.locator("::-p-text(Check patient data)").wait();
  await page.keyboard.type(idp);
  await page.keyboard.press("Enter");
  await sleep(5000); // spec: wait a few seconds for the association to take effect
  return target;
}

export async function exportPdf(s: Session, m: Measurement): Promise<string> {
  const id = m.originalMeasurementId; // matches the measurementId in the app's UI URLs; verify live
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
  return file;
}
