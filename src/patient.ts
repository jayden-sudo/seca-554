import { api } from "./api.js";
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

export async function createPatient(s: Session, p: NewPatient): Promise<void> {
  if (!/^[A-Za-z0-9-]+$/.test(p.externalPatientId)) throw new Error("IDP must match [A-Za-z0-9-]+");
  if (!GENDERS.includes(p.gender)) throw new Error(`gender must be one of ${GENDERS.join(", ")}`);
  if (!ETHNICITIES.includes(p.ethnicity)) throw new Error(`ethnicity must be one of ${ETHNICITIES.join(", ")}`);
  await api(s, "/api/back-office/v1/patient", {
    method: "POST",
    body: JSON.stringify({
      ...p,
      birthDate: `${p.birthDate}T00:00:00.000Z`,
      hasNoEmail: true,
      height: null,
    }),
  });
}
