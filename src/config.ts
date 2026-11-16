export interface Config {
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
  return {
    host: get("host"),
    tenant: get("tenant"),
    user: get("user"),
    password: get("password"),
    pdfDir: get("pdfDir"),
    csvDir: get("csvDir"),
  };
}
