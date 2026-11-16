import { loadConfig } from "./config.js";
import { exportCsv } from "./csv.js";
import { exportPdf, linkLatest, listMeasurements } from "./measurement.js";
import { createPatient, type NewPatient } from "./patient.js";
import { login } from "./session.js";

const USAGE = `Usage:
  create-patient <idp> <firstName> <lastName> <YYYY-MM-DD> <Male|Female> <ethnicity>
  link <idp>          link the newest unlinked measurement to patient <idp>
  export-csv
  export-pdf          export PDF of the newest measurement
  link-and-export <idp>   link, then export PDF and CSV`;

async function main() {
  const [cmd, ...a] = process.argv.slice(2);
  if (!cmd) {
    console.error(USAGE);
    process.exit(1);
  }
  const s = await login(loadConfig());
  try {
    switch (cmd) {
      case "create-patient": {
        const [externalPatientId, firstName, lastName, birthDate, gender, ethnicity] = a;
        await createPatient(s, { externalPatientId, firstName, lastName, birthDate, gender, ethnicity } as NewPatient);
        console.log(`created ${externalPatientId}`);
        break;
      }
      case "link":
        console.log("linked", (await linkLatest(s, a[0]!)).id);
        break;
      case "export-csv":
        console.log(await exportCsv(s));
        break;
      case "export-pdf": {
        console.log(await exportPdf(s, (await listMeasurements(s, 1))[0]!));
        break;
      }
      case "link-and-export": {
        const m = await linkLatest(s, a[0]!);
        const linked = (await listMeasurements(s)).find(
          (x) => x.originalMeasurementId === m.originalMeasurementId,
        );
        console.log(await exportPdf(s, linked ?? m));
        console.log(await exportCsv(s));
        break;
      }
      default:
        console.error(USAGE);
        process.exitCode = 1;
    }
  } finally {
    await s.browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
