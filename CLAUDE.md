# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

Skeleton implemented from the design spec `offlineDocs/1.md` (Traditional Chinese, the source of truth, with the captured API requests/responses). Nothing has been run against the live tenant. Selectors, the login form inputs, and the `id` vs `originalMeasurementId` choice for the PDF calls are assumptions marked in the code, so verify them live.

## Commands

```
npm install
npm run typecheck
npm run build              # tsc -> dist/
npm run dev -- <command>   # tsx, loads .env
docker build -t seca .     # official puppeteer base image; pass SECA_* via --env-file
```

CLI commands: `create-patient`, `link <idp>`, `export-csv`, `export-pdf`, `link-and-export <idp>`. `create-patient` is permanent and the IDP must be globally unique, so don't run it against the real tenant casually. There are no tests.

## Layout (`src/`, flat)

`config.ts` (env validation) → `session.ts` (Puppeteer login; captures cookies and the CSRF token from the app's own API requests) → `api.ts` (fetch wrapper to `api.{host}`) → `patient.ts`, `measurement.ts` (list, UI-link, PDF), `csv.ts` (browser download, since no HTTP endpoint is known) → `index.ts` (CLI). The CLI shape is an assumption. The spec doesn't say whether this should be a service or a one-shot job.

## What it is

An automation library/service for the `seca mBCA Pro` body-composition device via secacloud.com. It requires the user to have bought the `analytics125` service. Supported operations:

1. Log in to secacloud.com
2. `Create new patient`
3. `Data export` (CSV, and per-measurement PDF)

## Configuration

The Docker image takes these env vars (the root `.env` already holds real values, so don't print, log or commit it. There is no `.gitignore` yet, so add one that ignores `.env` before the first commit of code):

```
SECA_HOST=eu.secacloud.com   # region-specific host
SECA_TENANT=...              # tenant ID, appears in URL paths (e.g. 4SEASCNX)
SECA_USER=...
SECA_PASSWORD=...
SECA_OUT_PDF_DIR=...
SECA_OUT_CSV_DIR=...
```

## Architecture (from the spec)

**Hybrid approach: browser for login and association, plain HTTP for everything else.**

- **Login (Puppeteer):** open `https://{HOST}/{TENANT}/guest/login?accountType=analytics125` and poll every 3s.
  - If the URL becomes `https://{HOST}/{TENANT}/home`, login succeeded.
  - If a `<button>Login</button>` is present, fill in the username and password.
  - If the state is undetermined 10 consecutive times, exit.
  - Afterward, capture the cookies (`Authentication`, `AWSALB`, `AWSALBCORS`) and the CSRF token, then reuse them for direct HTTP calls. The spec prefers this over clicking through the UI.
- **API host** is `api.{HOST}`, e.g. `https://api.eu.secacloud.com`. Requests need the cookies above, plus `x-csrf-token`, `origin: https://{HOST}`, `scl-app-type: web`, `scl-app-version`, and an `scl-page-url` header. Use the full header set in the spec's curl examples.
- **CSV export:** from the `/{TENANT}/admin/data-manage` page's "Export data" button. Ideally replay it over HTTP with the stored cookies.
- **Create patient:** `POST /api/back-office/v1/patient` with the JSON body `{externalPatientId, firstName, lastName, birthDate (ISO), gender, ethnicity, hasNoEmail: true, height: null}`. Constraints:
  - `externalPatientId` (the "IDP") is globally unique and may contain only letters, digits and `-`.
  - `gender` is `Male` or `Female`.
  - `ethnicity` is one of `Afro-American`, `Asian`, `Caucasian`, `South and Central American`, `Japanese`, `Other`.
- **Linking an anonymous measurement to a patient:** this is essential. Without the link, the exported CSV contains only weight and height, because body-fat analysis needs the patient's age and ethnicity.
  - List measurements with `GET /api/analytics/v1/measurement?sortBy=measurementDate&take=30&ascending=false&isDeleted=false`. Unlinked ones have `patient.id` equal to the zero GUID and a null `externalPatientId`.
  - The spec says the HTTP flow for linking is too involved, so **use Puppeteer UI automation** for now:
    1. Open `/{TENANT}/measurements`.
    2. Click the latest record to open "Edit measurement data".
    3. Click `Select existing patient`.
    4. Enter the IDP in the "Check patient data" dialog.
    5. Wait a few seconds before exporting the CSV.
- **PDF export (HTTP):**
  1. `PUT /api/analytics/v1/measurement/{measurementId}/pdf/exportByIds` with the body `{pdfTemplates:"SingleView", chartTemplateId, isChartTemplateGlobal, locale, languageType, dateLocale, dateTimeZone, patientId, measurementIds:[...]}` returns a `pdfExportId`.
  2. Poll `GET /api/analytics/v1/measurement/pdf/{pdfExportId}/status` until `measurementPdfStatus.status` is `Finished` (it is `Generating` while in progress).
  3. `GET /api/analytics/v1/measurement/pdf/{pdfExportId}` returns the PDF bytes.

Note the two IDs on a measurement: `id` and `originalMeasurementId`. The spec's examples are not fully consistent about which one the PDF endpoints and UI URLs take. Verify against a live response before relying on either.
