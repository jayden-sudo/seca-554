import { api, apiJson } from "./api.js";
import { HttpError } from "./errors.js";
import type { Session } from "./session.js";

export const GENDERS = ["Male", "Female"] as const;
export const ETHNICITIES = [
  "Afro-American",
  "Asian",
  "Caucasian",
  "South and Central American",
  "Japanese",
  "Other",
] as const;

export interface NewPatient {
  /** "IDP": globally unique, letters/digits/'-' only. */
  externalPatientId: string;
  firstName: string;
  lastName: string;
  /** YYYY-MM-DD */
  birthDate: string;
  gender: (typeof GENDERS)[number];
  ethnicity: (typeof ETHNICITIES)[number];
}

/** Create a patient; every field is required. Returns the upstream response (the new patient). */
export async function createPatient(s: Session, p: NewPatient): Promise<unknown> {
  for (const k of ["externalPatientId", "firstName", "lastName", "birthDate", "gender", "ethnicity"] as const) {
    if (typeof p[k] !== "string" || !p[k].trim()) throw new HttpError(400, `${k} is required`);
  }
  if (!/^[A-Za-z0-9-]+$/.test(p.externalPatientId)) throw new HttpError(400, "externalPatientId must match [A-Za-z0-9-]+");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.birthDate) || Number.isNaN(Date.parse(p.birthDate))) {
    throw new HttpError(400, "birthDate must be a valid YYYY-MM-DD date");
  }
  if (!GENDERS.includes(p.gender)) throw new HttpError(400, `gender must be one of ${GENDERS.join(", ")}`);
  if (!ETHNICITIES.includes(p.ethnicity)) throw new HttpError(400, `ethnicity must be one of ${ETHNICITIES.join(", ")}`);
  // The IDP is globally unique; don't rely on upstream's (unobserved) duplicate handling.
  if (await searchPatient(s, p.externalPatientId)) throw new HttpError(409, `patient ${p.externalPatientId} already exists`);

  const res = await api(s, "/api/back-office/v1/patient", {
    method: "POST",
    body: JSON.stringify({
      ...p,
      birthDate: `${p.birthDate}T00:00:00.000Z`,
      hasNoEmail: true,
      height: null,
    }),
  });
  return res.json().catch(() => ({}));
}

export interface PatientRef {
  id: string;
  externalPatientId: string;
  height: { value: number; unit: string } | null;
}

/** Look up a patient by its IDP (exact match); null when there is none. */
export async function searchPatient(s: Session, idp: string): Promise<PatientRef | null> {
  const r = await apiJson<{ patients: PatientRef[] }>(
    s,
    `/api/back-office/v1/patient/search?searchKeyword=${encodeURIComponent(idp)}&take=30`,
  );
  return r.patients.find((x) => x.externalPatientId === idp) ?? null;
}

export async function findPatient(s: Session, idp: string): Promise<PatientRef> {
  const p = await searchPatient(s, idp);
  if (!p) throw new HttpError(404, `No patient with IDP "${idp}"`);
  return p;
}
