# seca-554

A small HTTP service in front of [secacloud](https://secacloud.com) (seca mBCA Pro, `analytics125`). It keeps one logged-in browser session open and exposes five operations as a plain JSON API:

- create a patient
- list recent measurements
- link a measurement to a patient
- get a patient's CSV row as JSON
- download a measurement's PDF

**To save time you can skip the build:** a ready-made image is on Docker Hub as `jayden4sudo/seca-554`. Install Docker, write a `.env`, and run it (see [Quick start](#quick-start-docker-hub)). Prefer to build it yourself? That works too, see [Build and publish](#build-and-publish).

The secacloud web app has no official API. This project uses the same HTTP calls the web app makes (the reseller allows direct HTTP access for web cloud customers). Treat them as undocumented: they can change without notice.

## How it works

- A headed Chromium logs in once (username + password) and stays open. The page is refreshed every 60 s so the session never expires. The cookies and CSRF token are read from that browser.
- Every operation is a direct HTTP request to `api.<host>`. A 401 triggers a re-login and one retry. A 429 is retried with backoff.
- The browser must be **headed**: secacloud answers headless Chrome with a 403. Docker runs it under Xvfb.
- The login session is kept in `SECA_SESSION_DIR` (cookies plus the Chrome profile), so restarts reuse it.

## Quick start (Docker Hub)

The quickest way is the prebuilt image [`jayden4sudo/seca-554`](https://hub.docker.com/r/jayden4sudo/seca-554) (`linux/amd64` and `linux/arm64`): `docker run` pulls it for you, so there is nothing to compile. All you need is Docker and a secacloud account with the `analytics125` service.

1. Create a `.env` file (copy `.env.example`) with your own values:

   ```
   SECA_HOST=eu.secacloud.com
   SECA_TENANT=<your tenant id>
   SECA_USER=<your username>
   SECA_PASSWORD=<your password>
   SECA_OUT_PDF_DIR=/data/pdf
   SECA_OUT_CSV_DIR=/data/csv
   ```

2. Start it:

   ```sh
   docker run -d --name seca --restart unless-stopped \
     --env-file .env \
     -v seca-data:/data \
     -p 127.0.0.1:3000:3000 \
     jayden4sudo/seca-554:latest
   ```

3. Check it (the first start takes about 30 s because it logs in):

   ```sh
   docker logs seca                       # expect: "listening on http://0.0.0.0:3000"
   curl localhost:3000/measurements
   ```

Update with `docker pull jayden4sudo/seca-554:latest`, then `docker rm -f seca` and run step 2 again (the `seca-data` volume keeps the login session). Pin a version such as `jayden4sudo/seca-554:0.1.0` for reproducible deployments.

You are also free to build the image from source instead, see [Build and publish](#build-and-publish).

### Configuration

Environment variables (see `.env.example`):

| Variable | Meaning |
|---|---|
| `SECA_HOST` | Region host, e.g. `eu.secacloud.com` |
| `SECA_TENANT` | Tenant ID from your login URL |
| `SECA_USER` / `SECA_PASSWORD` | Login |
| `SECA_OUT_PDF_DIR` / `SECA_OUT_CSV_DIR` | Where PDFs / CSV files are also saved |
| `SECA_PORT`, `SECA_BIND` | Listen port (default `3000`) and address (default `127.0.0.1`; the image sets `0.0.0.0`) |
| `SECA_SESSION_DIR` | Login session storage (default `.session`; the image uses `/data/session`) |
| `SECA_MODE` | `api` (default) or `ui`, see below |

Mount a volume on `/data`, otherwise every restart logs in again. Credentials are passed at run time and are not baked into the image.

**There is no authentication and the API serves health data.** Publish the port on `127.0.0.1` only, or put it behind something that authenticates.

## HTTP API

Errors are `{"error": "..."}` with the status shown. Upstream failures are 502, upstream rate limits 503.

| Method and path | Description |
|---|---|
| `POST /patients` | Body: `{externalPatientId, firstName, lastName, birthDate, gender, ethnicity}`, all required. `birthDate` is `YYYY-MM-DD`, `gender` is `Male` or `Female`, `ethnicity` is one of `Afro-American`, `Asian`, `Caucasian`, `South and Central American`, `Japanese`, `Other`. `externalPatientId` (the IDP) is globally unique and may contain only letters, digits and `-`. Returns 201 with `{patientId, externalPatientId, age, height}`. 400 for invalid input, 409 if the IDP exists. |
| `GET /measurements` | The newest 30 measurements: `[{measurementId, measurementDate, externalPatientId}]`. `measurementDate` is unix seconds. `externalPatientId` is `null` until the measurement is linked. |
| `POST /measurements/{measurementId}/link` | Body: `{externalPatientId}`. Links the measurement to that patient. 200 (also when it is already linked to that patient, with no change). **409 if it belongs to a different patient: it is never re-assigned.** 404 for an unknown measurement or patient. |
| `GET /patients/{externalPatientId}/csv` | The patient's newest row of the CSV export as one JSON object (176 columns, empty cells are `null`, other values stay strings). 404 if there is none. |
| `GET /measurements/{measurementId}/pdf` | The single-measurement report as `application/pdf` (also saved to `SECA_OUT_PDF_DIR`). 409 if the measurement is not linked yet. |

`measurementId` is the id from `GET /measurements`; the service finds older measurements by paging, so it is not limited to the newest 30.

Typical flow after someone has been measured:

```sh
curl -X POST localhost:3000/patients -H 'content-type: application/json' \
  -d '{"externalPatientId":"P0001","firstName":"A","lastName":"B","birthDate":"1990-01-02","gender":"Female","ethnicity":"Asian"}'
curl localhost:3000/measurements                  # find the new measurement with externalPatientId null
curl -X POST localhost:3000/measurements/<measurementId>/link -H 'content-type: application/json' \
  -d '{"externalPatientId":"P0001"}'
curl localhost:3000/patients/P0001/csv            # a few seconds after linking
curl -o report.pdf localhost:3000/measurements/<measurementId>/pdf
```

Link before reading the CSV: an unlinked measurement only has weight and height, because body composition needs the patient's age, sex and ethnicity. After linking, wait a few seconds for the values to appear.

## CLI

The same code is available as a CLI (`npm run dev -- <command>`, or `node dist/index.js <command>`): `create-patient`, `link`, `export-csv`, `export-pdf`, `link-and-export`, `keepalive`, `serve`. Pass `--api` (default) or `--ui`. `--ui` simulates clicks in the web app, only for `link` and `export-csv`; the other commands still use HTTP. UI mode is a fallback: it is slower, and the link click-through has failed in testing for an unknown reason. `serve` in `ui` mode rejects linking a specific measurement.

## Known limits

- Undocumented upstream API; a secacloud update can break it.
- Linking a measurement that was **never linked before** has been verified only for re-assignment between test patients, not yet for a fresh anonymous measurement with a full body-composition result. Verify the first real one (check the CSV for body-fat columns).
- The upstream allows only a few PDF exports in a short burst (about 4, then 429 for ~30 s). The service waits and retries.
- `GET /patients/{id}/csv` downloads the whole export on every call.

## Build and publish

Use this if you want to change the code or publish your own image. If you only want to run the service, the prebuilt `jayden4sudo/seca-554` in the [Quick start](#quick-start-docker-hub) saves you the build.

Docker needs `buildx` (included in Docker Desktop and current Docker Engine). The image is `node:24-slim` plus Chromium and Xvfb, started by `docker-entrypoint.sh`. It does not contain `.env`, the login session or any credentials; those come in at run time.

**Build and try locally** (your machine's architecture only):

```sh
docker build -t seca .
docker run -d --name seca --env-file .env -v seca-data:/data -p 127.0.0.1:3000:3000 seca
```

**Publish to Docker Hub** (both architectures, one multi-platform tag):

```sh
docker login                                   # once; use a Docker Hub access token
VERSION=0.1.0                                  # keep in step with "version" in package.json
docker buildx build --platform linux/amd64,linux/arm64 \
  -t jayden4sudo/seca-554:latest \
  -t jayden4sudo/seca-554:$VERSION \
  --push .
```

Verify what was published, then run it as a user would:

```sh
docker buildx imagetools inspect jayden4sudo/seca-554:latest      # lists linux/amd64 and linux/arm64
docker run -d --name seca-check --env-file .env -v seca-check:/data -p 127.0.0.1:3001:3000 jayden4sudo/seca-554:latest
curl localhost:3001/measurements
docker rm -f seca-check && docker volume rm seca-check
```

Notes:

- Build only `--platform linux/amd64,linux/arm64`. The official `ghcr.io/puppeteer/puppeteer` image is amd64-only, which is why this image is built from `node:24-slim`.
- If `buildx` reports that the driver does not support multi-platform builds, run `docker buildx create --use` once (or enable the containerd image store in Docker Desktop).
- Building the non-native architecture runs under emulation and takes a few minutes. `--push` sends the images straight to the registry; they are not kept in the local image list.
- Never `COPY` or bake `.env` into the image. `.dockerignore` excludes it.
- A new repository on Docker Hub is public by default; change it in the repository settings on hub.docker.com if you want it private.

## Development

```sh
npm install
npm run typecheck
npm run dev -- serve      # loads .env; needs a local Chrome (puppeteer downloads one on install)
```

`CLAUDE.md` has the details learned from the live system (login form, request flow, pitfalls).
