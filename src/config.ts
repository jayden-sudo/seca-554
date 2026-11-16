/** "api": direct HTTP calls (default). "ui": simulate clicks in the web app where an implementation exists. */
export type Mode = "api" | "ui";

export interface Config {
  mode: Mode;
  host: string;
  tenant: string;
  user: string;
  password: string;
  pdfDir: string;
  csvDir: string;
}

const KEYS = {
  host: "SECA_HOST",
  tenant: "SECA_TENANT",
  user: "SECA_USER",
  password: "SECA_PASSWORD",
  pdfDir: "SECA_OUT_PDF_DIR",
  csvDir: "SECA_OUT_CSV_DIR",
} as const;

export function loadConfig(env = process.env): Config {
  const missing = Object.values(KEYS).filter((k) => !env[k]);
  if (missing.length) throw new Error(`Missing env vars: ${missing.join(", ")}`);
  const get = (k: keyof typeof KEYS) => env[KEYS[k]]!;
  const mode = env.SECA_MODE ?? "api";
  if (mode !== "api" && mode !== "ui") throw new Error(`SECA_MODE must be "api" or "ui", got "${mode}"`);
  return {
    mode,
    host: get("host"),
    tenant: get("tenant"),
    user: get("user"),
    password: get("password"),
    pdfDir: get("pdfDir"),
    csvDir: get("csvDir"),
  };
}
