import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { api } from "./api.js";
import { HttpError } from "./errors.js";
import type { Session } from "./session.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Export the CSV: over HTTP by default, via the "Export data" button in mode "ui". Returns null when there is no data. */
export async function exportCsv(s: Session): Promise<string | null> {
  return s.cfg.mode === "ui" ? exportCsvViaButton(s) : exportCsvViaApi(s);
}

/** GET /measurement/export returns the CSV directly (JSON `NothingToExport` when there is no data). */
async function exportCsvViaApi(s: Session): Promise<string | null> {
  const dir = resolve(s.cfg.csvDir);
  await mkdir(dir, { recursive: true });
  const res = await api(s, "/api/analytics/v1/measurement/export");
  if (/json/i.test(res.headers.get("content-type") ?? "")) {
    const j = (await res.json()) as { errorCode?: string };
    if (j.errorCode === "NothingToExport") return null;
    throw new Error(`CSV export failed: ${JSON.stringify(j)}`);
  }
  const file = resolve(dir, `seca-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`);
  await writeFile(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

/** Click "Export data" in the UI and capture the browser download. */
async function exportCsvViaButton(s: Session): Promise<string> {
  const dir = resolve(s.cfg.csvDir);
  await mkdir(dir, { recursive: true });
  const page = await s.newPage();
  const cdp = await s.browser.target().createCDPSession();
  try {
    // "allow" did not put the file in downloadPath here; "allowAndName" does, saving it under a GUID name.
    await cdp.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: dir, eventsEnabled: true });
    let name = "";
    let guid = "";
    const done = new Promise<void>((ok, fail) => {
      cdp.on("Browser.downloadWillBegin", (e) => {
        name = e.suggestedFilename;
        guid = e.guid;
      });
      cdp.on("Browser.downloadProgress", (e) => {
        if (e.guid === guid && e.state === "completed") ok();
        if (e.guid === guid && e.state === "canceled") fail(new Error("CSV download was canceled"));
      });
    });
    await page.goto(`https://${s.cfg.host}/${s.cfg.tenant}/admin/data-manage?tab=export`, { waitUntil: "networkidle2" });
    // The first click can land before the app is interactive and do nothing: click again if no download starts.
    for (let i = 0; i < 3 && !guid; i++) {
      await sleep(2000);
      await page.locator("button::-p-text(Export data)").click();
      for (let w = 0; w < 10 && !guid; w++) await sleep(1000);
    }
    if (!guid) throw new Error("Clicking Export data never started a download");
    await Promise.race([done, sleep(60_000).then(() => Promise.reject(new Error("CSV download did not finish within 60s")))]);
    const file = resolve(dir, name || `seca-${guid}.csv`);
    await rename(resolve(dir, guid), file);
    return file;
  } finally {
    await cdp.detach().catch(() => {});
    await page.close();
  }
}

/** Minimal RFC 4180 parser (quoted fields, doubled quotes, newlines inside quotes); drops a leading BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') (field += '"', i++);
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") (row.push(field), (field = ""));
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) (row.push(field), rows.push(row));
  return rows;
}

/** The full CSV export as text (null when there is nothing to export). */
async function csvText(s: Session): Promise<string | null> {
  if (s.cfg.mode === "ui") {
    const file = await exportCsvViaButton(s);
    return file ? readFile(file, "utf8") : null;
  }
  const res = await api(s, "/api/analytics/v1/measurement/export");
  if (/json/i.test(res.headers.get("content-type") ?? "")) return null;
  return res.text();
}

/**
 * The newest CSV row of the patient with this IDP, as an object keyed by column name (empty cells -> null,
 * everything else stays a string). The export always contains every measurement; this picks one patient's row.
 */
export async function csvRowForPatient(s: Session, idp: string): Promise<Record<string, string | null>> {
  const text = await csvText(s);
  const [header, ...rows] = text ? parseCsv(text) : [];
  const col = header?.indexOf("ExternalPatientId") ?? -1;
  if (!header || col < 0) throw new Error("CSV export has no ExternalPatientId column; the export format may have changed");
  const dateCol = header.indexOf("MeasurementDate");
  const mine = rows.filter((r) => r[col] === idp).sort((a, b) => (b[dateCol] ?? "").localeCompare(a[dateCol] ?? ""));
  if (!mine[0]) throw new HttpError(404, `No CSV data for patient ${idp}`);
  return Object.fromEntries(header.map((h, i) => [h, mine[0]![i] ? mine[0]![i]! : null]));
}
