# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

Implemented from the design spec `offlineDocs/1.md` (Traditional Chinese, with the captured API requests/responses). It is git-ignored, so it may be absent in a fresh clone. Every flow below was run against the live tenant on 2026-11-16: login, session reuse, CSV export, PDF export, `create-patient`, `link`. `link-and-export` is just those combined and was not run as one command.

## Commands

```
npm install
npm run typecheck
npm run build              # tsc -> dist/
npm run dev -- <command>   # tsx, loads .env
npm run dev -- serve       # HTTP API on SECA_BIND:SECA_PORT (default 127.0.0.1:3000)
docker build -t seca .     # verified; see README for the run command
```

CLI commands: `create-patient`, `link <idp> [measurementId]`, `export-csv`, `export-pdf`, `link-and-export <idp> [measurementId]`, `keepalive [seconds]`, `serve`. The CLI's `measurementId` is the public id (upstream `originalMeasurementId`). Mode: `--api` (default, direct HTTP) or `--ui` (simulated clicks), or `SECA_MODE=api|ui`. Only `link` and `export-csv` have a UI implementation; in `--ui` mode the other commands use HTTP. `create-patient` and `link` change real data and can't be undone from here, and the IDP must be globally unique. Test patients: `CLAUDE-TEST-0001`, `CLAUDE-TEST-0002`. **The tenant is in live use by other people and also holds ~12 old unlinked measurements, so `link` without a measurement id picks the first unlinked one among the newest 30, which may be an old one. Check `listMeasurements` first and pass an explicit measurement id.** There are no tests.

## Layout (`src/`, flat)

`server.ts` + `serve` in `index.ts` expose everything as an HTTP API (below); `errors.ts` has `HttpError(status)`. `config.ts` (env validation, mode) → `session.ts` (Puppeteer login, session reuse, `refresh`, `keepAlive`, `newPage`) → `api.ts` (fetch wrapper to `api.{host}`; on 401 it refreshes/re-logins once and retries) → `patient.ts`, `measurement.ts` (list, UI-link, PDF), `csv.ts` → `index.ts` (CLI). The CLI shape is an assumption. The spec doesn't say whether this should be a service or a one-shot job.

## Docker (verified)

`node:24-slim` plus apt `chromium`/`xvfb` (the official puppeteer image is amd64-only and doesn't pull on Apple Silicon). `docker-entrypoint.sh` starts Xvfb itself because `xvfb-run` hangs as PID 1, and it first removes the previous run's `/tmp/.X99-lock` (a stopped/restarted container otherwise fails with "Missing X server"). `session.ts` removes Chrome's stale `Singleton*` profile locks at start (a replaced container has a new hostname and Chrome otherwise refuses the profile and times out). Session storage is `/data/session`; mount a volume there. Tested: fresh start, stop/start, restart, kill/start, 29 endpoint checks including error cases, 3 refreshes while idle, the image holds no `.env` or credentials. Not tested: runs longer than a few minutes (memory was ~450 MB), a session lost inside the container.

## HTTP API (`serve`)

One process: logs in once, `keepAlive` every 60s, all operations over HTTP. Every route below was run live except a first-time link. No authentication, and it serves health data, so keep it on 127.0.0.1 or behind something that authenticates.

- `POST /patients` JSON `{externalPatientId, firstName, lastName, birthDate: "YYYY-MM-DD", gender, ethnicity}`, all required. 201 with the upstream `{patientId, externalPatientId, age, height}`; 400 invalid; 409 IDP exists (checked first, since duplicate handling upstream was never observed).
- `GET /measurements` → `[{measurementId, measurementDate (unix seconds), externalPatientId}]`, newest 30. `measurementId` is the upstream `originalMeasurementId`. Every other route takes this public id and resolves it to the upstream `id` by paging history (`take=100` plus `nextItemId`/`nextSortValue`).
- `POST /measurements/{measurementId}/link` JSON `{externalPatientId}`. 200 also when already linked to that patient (no-op); **409 if it belongs to a different patient** (never re-assigns); 404 unknown measurement or patient; 501 in ui mode.
- `GET /patients/{idp}/csv` → the patient's newest CSV row as a JSON object (176 columns, empty → null, other values stay strings); 404 if none. It exports the whole CSV each call. Right after a link the row can lag by a few seconds.
- `GET /measurements/{measurementId}/pdf` → `application/pdf`; 409 if the measurement isn't linked; also saved to `SECA_OUT_PDF_DIR`.
- Errors are `{"error": "..."}`; upstream failures are 502.

## Verified behavior (differs from or extends the spec)

- **Chrome must be headed.** Headless Chrome gets a 403 on the API's CORS preflight and the app shows "Application failed to load". `session.ts` launches with `headless: false`. In Docker this needs a virtual display (Xvfb). Do not spoof the User-Agent to get around this; that was tried and blocked as detection evasion.
- **Session reuse:** the login cookie is a session cookie, and the server also requires the CSRF token with it. So `session.ts` keeps a persistent Chrome profile (its local storage holds the token) in `.session/profile`, plus `.session/cookies.json`. Both are git-ignored. Cookies alone get a 401. The `SECA_SESSION_DIR` env var overrides the location; in Docker mount it as a volume. The login log prints `reused saved session` or `logged in with username/password`.
- **Login form:** inputs are `input[formcontrolname=externalTenantId|username|password]`.
- **API headers:** `x-csrf-token` and `scl-app-version` are copied from the app's own API requests, and `user-agent` is the browser's.
- **CSV export** in api mode is plain HTTP: `GET /api/analytics/v1/measurement/export` returns the CSV directly, or JSON with `errorCode: "NothingToExport"` when empty. In ui mode it clicks `Export data`, which fires the same request and downloads a blob. That needs `Browser.setDownloadBehavior` with `allowAndName` on a browser-level CDP session (plain `allow` doesn't write to the target dir), and the first click can land before the page is ready, so it retries.
- **PDF export** uses the measurement's `id` (not `originalMeasurementId`, which only appears in UI URLs) in both the path and `measurementIds`. A measurement keeps the same `id` after being linked.
- **Link over HTTP (api mode, default):** `GET /api/back-office/v1/patient/search?searchKeyword={idp}&take=30` gives the patient `id`. `GET /api/analytics/v1/measurement/additional-data/{measurementId}` returns the measurement's current `measurements` (height, waist, weight), `pal`, `comment`. `POST` the same path with `{patientId, measurements, pal, comment}` to link, which returns `{"measurementsAffected":"Current"}`. The UI's Assign/Save/Proceed only build this one request. Verified live for re-assigning a measurement between two patients. **Not verified for a never-linked measurement**, where the height the UI sends may come from the patient's reference height; the code falls back to the patient's height when the measurement has none. Link by explicit measurement id whenever several people may measure at the same time.
- **Upstream rate limit:** about 4 PDF exports in a short burst, then `429` for ~30 s. `api()` retries 429 with backoff (Retry-After, else 1s, 2s, 4s...) and gives up with 503. Real usage is one measurement per ~2 minutes per device, so parallel load is not a goal and was not tested.
- **Long-lived session:** `keepAlive(s, ms)` reloads the logged-in page via the login URL (a valid session redirects to `/home`; a lost one shows the login form and logs in again) and then checks `GET /api/back-office/v1/identity`; the URL alone doesn't prove the session works. Verified: 3 refreshes with API calls between, and recovery after deleting the `Authentication` cookie. UI automation uses `s.newPage()` tabs so it doesn't collide with the refreshed page. The long-running host process (service, or the user's own app) is not built yet; `keepalive` is only a standalone demo.
- **Link flow (UI):** `/{TENANT}/measurements` is a card list in the same order as the API list, and unlinked cards read "No name". Steps: click the first "No name" card → "Edit measurement data" → `Select existing patient` → type the IDP → `Assign` → `Save` → `Proceed` (a "Confirm change" dialog; this is the step that persists). Pressing Enter in the search box does nothing. Clicks need `button::-p-text(...)` selectors and a short wait for dialog animations. Success is confirmed by polling the API until the measurement's `patient.id` is no longer the zero GUID. It links the newest unlinked measurement, not necessarily the newest row. Worked once; a later run clicked through every step but the measurement stayed unlinked and the cause is unknown, so treat ui link as unreliable.
- A page script passed to `page.evaluate` as a function breaks under tsx (`__name is not defined`). Pass a string instead.

## What it is

An automation library/service for the `seca mBCA Pro` body-composition device via secacloud.com. It requires the user to have bought the `analytics125` service. Supported operations:

1. Log in to secacloud.com
2. `Create new patient`
3. `Data export` (CSV, and per-measurement PDF)

## Configuration

The Docker image takes these env vars. The root `.env` holds real values, so don't print, log or commit it (it is git-ignored; `.env.example` is the template):

```
SECA_HOST=eu.secacloud.com   # region-specific host
SECA_TENANT=...              # tenant ID, appears in URL paths (e.g. 4SEASCNX)
SECA_USER=...
SECA_PASSWORD=...
SECA_OUT_PDF_DIR=...
SECA_OUT_CSV_DIR=...
```
