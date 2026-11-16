import { mkdir, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Session } from "./session.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** No HTTP endpoint is documented, so click "Export data" and capture the browser download. */
export async function exportCsv(s: Session): Promise<string> {
  const dir = resolve(s.cfg.csvDir);
  await mkdir(dir, { recursive: true });
  const before = new Set(await readdir(dir));
  const cdp = await s.browser.target().createCDPSession();
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dir });

  await s.page.goto(`https://${s.cfg.host}/${s.cfg.tenant}/admin/data-manage`);
  await s.page.locator("::-p-text(Export data)").click();

  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const fresh = (await readdir(dir)).filter((f) => !before.has(f));
    const done = fresh.find((f) => f.endsWith(".csv"));
    if (done) return resolve(dir, done);
  }
  throw new Error("CSV download did not appear within 60s");
}
