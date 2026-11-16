import { loadConfig, type Mode } from "./config.js";
import { exportCsv } from "./csv.js";
import { exportPdf, linkMeasurement, listMeasurements } from "./measurement.js";
import { createApiServer } from "./server.js";
import { createPatient, type NewPatient } from "./patient.js";
import { keepAlive, login } from "./session.js";

const USAGE = `Usage: index.js [--api | --ui] <command>
  --api (default) direct HTTP calls; --ui simulate clicks where implemented (link, export-csv).
  The mode can also be set with SECA_MODE=api|ui.

  create-patient <idp> <firstName> <lastName> <YYYY-MM-DD> <Male|Female> <ethnicity>
  link <idp> [measurementId]   link a measurement (default: the newest unlinked) to patient <idp>
  export-csv
  export-pdf                   PDF of the newest measurement
  link-and-export <idp> [measurementId]
  keepalive [seconds]          stay logged in, refreshing the page (default 60s); Ctrl-C to stop
  serve                        HTTP API on SECA_BIND:SECA_PORT (default 127.0.0.1:3000)`;

async function main() {
  const args = process.argv.slice(2);
  const flag = args.find((a) => a === "--api" || a === "--ui");
  const [cmd, ...a] = args.filter((x) => x !== flag);
  if (!cmd) {
    console.error(USAGE);
    process.exit(1);
  }
  const cfg = loadConfig();
  if (flag) cfg.mode = flag.slice(2) as Mode;
  if (cfg.mode === "ui" && (cmd === "create-patient" || cmd === "export-pdf" || cmd === "link-and-export")) {
    console.error("note: ui mode has no click implementation for patient creation or PDF export; those use HTTP");
  }

  const s = await login(cfg);
  try {
    switch (cmd) {
      case "create-patient": {
        const [externalPatientId, firstName, lastName, birthDate, gender, ethnicity] = a;
        await createPatient(s, { externalPatientId, firstName, lastName, birthDate, gender, ethnicity } as NewPatient);
        console.log(`created ${externalPatientId}`);
        break;
      }
      case "link":
        console.log("linked", (await linkMeasurement(s, a[0]!, a[1])).patient.externalPatientId);
        break;
      case "export-csv":
        console.log((await exportCsv(s)) ?? "nothing to export");
        break;
      case "export-pdf":
        console.log((await exportPdf(s, (await listMeasurements(s, 1))[0]!)).file);
        break;
      case "link-and-export":
        console.log((await exportPdf(s, await linkMeasurement(s, a[0]!, a[1]))).file);
        console.log((await exportCsv(s)) ?? "nothing to export");
        break;
      case "keepalive": {
        const sec = Number(a[0] ?? 60);
        const stop = keepAlive(s, sec * 1000);
        console.error(`logged in; refreshing every ${sec}s (Ctrl-C to stop)`);
        await new Promise<void>((done) => process.once("SIGINT", () => (stop(), done())));
        break;
      }
      case "serve": {
        const stop = keepAlive(s); // refresh the logged-in page every 60s
        const server = createApiServer(s);
        const port = Number(process.env.SECA_PORT ?? 3000);
        const bind = process.env.SECA_BIND ?? "127.0.0.1";
        await new Promise<void>((ok, fail) => (server.once("error", fail), server.listen(port, bind, ok)));
        console.error(`listening on http://${bind}:${port} (mode: ${cfg.mode})`);
        await new Promise<void>((done) => {
          for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => done());
        });
        stop();
        server.close();
        break;
      }
      default:
        console.error(USAGE);
        process.exitCode = 1;
    }
  } finally {
    await s.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
