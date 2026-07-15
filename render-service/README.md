# @openmaic/render-service

Isolated MP4 render service for OpenMAIC's classroom video export (issue #866).

The main app compiles a classroom to a self-contained Hyperframes project ZIP
(`index.html` + `assets/` + vendored GSAP) entirely in the browser. This service
takes that ZIP and renders it to an MP4 with [`@hyperframes/producer`], which
drives headless Chromium (frame capture) + FFmpeg (encode). It runs in its own
Node 22 container because the producer needs Node ≥ 22, Chromium, and FFmpeg —
none of which belong in the Next.js runtime.

It is an **opt-in capability**: when the app has no `RENDER_SERVICE_URL`
configured, in-app export degrades to downloading the project ZIP for local CLI
rendering. Nothing here is required for the app to run.

## HTTP API

Rendering is asynchronous (a 10-minute video can take tens of minutes): submit,
poll, then download. Job ids are opaque.

| Method + path | Purpose |
| --- | --- |
| `POST /render` | multipart: `project` (the ZIP) + `fps`, `quality`, `format` fields → `202 { jobId }` |
| `GET /render/:jobId` | `{ status, progress, currentStage, framesRendered, totalFrames, done, error }` |
| `GET /render/:jobId/download` | stream the MP4 (or `302` to a presigned URL) once `succeeded` |
| `DELETE /render/:jobId` | cancel a queued/running job |
| `GET /health` | `{ ok: true }` |

`status` is one of `queued | running | succeeded | failed | cancelled`;
`progress` is `0..1`.

## Environment

| Var | Default | Meaning |
| --- | --- | --- |
| `PORT` | `9000` | Listen port. |
| `RENDER_MAX_CONCURRENCY` | `2` | Renders that execute simultaneously; extras queue FIFO. |
| `RENDER_MAX_JOBS_PER_USER` | `1` | Active jobs allowed per `userId` (0 disables the guard). |
| `RENDER_JOB_TTL_MS` | `1800000` | How long finished jobs + artifacts live before cleanup. |
| `PRODUCER_TMP_PROJECT_DIR` | `/tmp/openmaic-renders` | Scratch dir for unzipped projects + outputs. |
| `PUPPETEER_EXECUTABLE_PATH` | `/usr/bin/chromium` | System Chromium (set in the image). |

## Run

### Docker (recommended)

The root `docker-compose.yml` wires this service under the `video-export`
profile and points the app at it:

```bash
docker compose --profile video-export up --build
```

### Standalone (development)

Requires Node ≥ 22, plus Chromium and FFmpeg on `PATH`:

```bash
cd render-service
npm install
PUPPETEER_EXECUTABLE_PATH=$(which chromium) npm start
```

## Scalability

The service is built with two swap points so it can move from a single OSS host
to a horizontally-scaled demo deployment without changing the HTTP contract or
the app:

- **`JobStore`** (`src/job-store.ts`) — Part A ships `InMemoryJobStore`. A
  `RedisJobStore` implementing the same interface lets any replica serve poll /
  download requests.
- **`ArtifactStore`** (`src/artifact-store.ts`) — Part A ships
  `LocalDiskArtifactStore` (streams through the app proxy). An `S3ArtifactStore`
  whose `locate` returns a presigned URL makes the download route `302` the
  browser straight to object storage, bypassing the proxy.

Chunked distributed rendering (`@hyperframes/producer/distributed`) to cut
single-job latency is a further, separate follow-up.

[`@hyperframes/producer`]: https://www.npmjs.com/package/@hyperframes/producer
