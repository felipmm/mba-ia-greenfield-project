---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-04-08T14:58:57-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-29T00:00:00-03:00"
  docs/phases/phase-03-videos/context.md: "2026-07-29T00:00:00-03:00"
  docs/phases/phase-02-auth/phase-02-auth.md: "2026-05-12T12:23:19-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver the complete video upload and processing pipeline — object storage (MinIO), async queue (BullMQ + Redis), a dedicated FFmpeg worker, streaming and download endpoints, and a Video entity with a defined status lifecycle — establishing the video foundation for all subsequent phases.

---

## Technical Specifications

### Data Model

#### Video Entity

```
Table: videos
├── id                    INTEGER       PK, auto-increment
├── url_hash              VARCHAR(21)   UNIQUE, NOT NULL, INDEX (Nano ID)
├── title                 VARCHAR(255)  NOT NULL, DEFAULT '' (editable in Phase 04)
├── description           TEXT          NULLABLE (editable in Phase 04)
├── status                ENUM          NOT NULL, DEFAULT 'draft'
│   Values: 'draft', 'uploading', 'processing', 'ready', 'error'
├── error_message         TEXT          NULLABLE
├── duration_seconds      FLOAT         NULLABLE
├── file_size_bytes       BIGINT        NULLABLE
├── width                 INTEGER       NULLABLE
├── height                INTEGER       NULLABLE
├── codec                 VARCHAR(50)   NULLABLE
├── bitrate_bps           INTEGER       NULLABLE
├── storage_bucket        VARCHAR(100)  NOT NULL
├── storage_key           VARCHAR(500)  NOT NULL (video file path in bucket)
├── thumbnail_storage_key VARCHAR(500)  NULLABLE (thumbnail file path in bucket)
├── channel_id            INTEGER       FK → channels, NOT NULL, INDEX
├── upload_id             VARCHAR(255)  NULLABLE (S3 multipart upload ID)
├── created_at            TIMESTAMPTZ   DEFAULT now()
├── updated_at            TIMESTAMPTZ   DEFAULT now()
```

**Status transitions:**
- `draft` → `uploading`: when the first presigned part URL is requested
- `uploading` → `processing`: when `CompleteMultipartUpload` succeeds and the job is enqueued
- `processing` → `ready`: when the worker finishes successfully (metadata + thumbnail)
- `processing` → `error`: when the worker fails irrecoverably
- `draft` → (deleted): when upload is aborted before completion
- `uploading` → (deleted): when upload is aborted

### API Contracts

#### POST /videos/initiate-upload — Initiate video upload

**Auth:** Required (JWT)
**Request:**
```json
{
  "fileName": "my-video.mp4",
  "fileSize": 1073741824,
  "mimeType": "video/mp4",
  "partCount": 5
}
```
**Response (201):**
```json
{
  "video": {
    "id": 1,
    "urlHash": "abc123def456ghi789jkl",
    "status": "draft"
  },
  "uploadId": "minio-multipart-upload-id",
  "presignedUrls": [
    { "partNumber": 1, "url": "http://minio:9000/bucket/key?partNumber=1&uploadId=..." },
    { "partNumber": 2, "url": "http://minio:9000/bucket/key?partNumber=2&uploadId=..." }
  ],
  "expiresAt": "2026-07-29T01:00:00.000Z"
}
```

#### POST /videos/:id/complete-upload — Complete multipart upload

**Auth:** Required (JWT, must be the video owner)
**Request:**
```json
{
  "parts": [
    { "partNumber": 1, "etag": "\"abc123\"" },
    { "partNumber": 2, "etag": "\"def456\"" }
  ]
}
```
**Response (200):**
```json
{
  "video": {
    "id": 1,
    "urlHash": "abc123def456ghi789jkl",
    "status": "processing"
  }
}
```

#### POST /videos/:id/abort-upload — Abort multipart upload

**Auth:** Required (JWT, must be the video owner)
**Response (204):** No content

#### GET /videos/:urlHash/stream — Stream video

**Auth:** None (public)
**Headers:** `Range: bytes=0-1048575`
**Response (206):**
```
Content-Range: bytes 0-1048575/1073741824
Content-Type: video/mp4
Accept-Ranges: bytes
```
Body: binary stream from MinIO.

#### GET /videos/:urlHash/download — Download video

**Auth:** None (public)
**Response (200):**
```
Content-Disposition: attachment; filename="video.mp4"
Content-Type: application/octet-stream
```
Body: full binary from MinIO (no Range handling).

### Authorization Matrix

| Endpoint | Method | Auth | Owner Only | Notes |
|----------|--------|------|------------|-------|
| `/videos/initiate-upload` | POST | Required | N/A | Any authenticated user |
| `/videos/:id/complete-upload` | POST | Required | Yes | Video owner only |
| `/videos/:id/abort-upload` | POST | Required | Yes | Video owner only |
| `/videos/:urlHash/stream` | GET | None | No | Public access |
| `/videos/:urlHash/download` | GET | None | No | Public access |

### Error Catalog

| Error Code | HTTP Status | Trigger |
|------------|-------------|---------|
| `VIDEO_NOT_FOUND` | 404 | Video with given `urlHash` not found |
| `VIDEO_NOT_OWNED` | 403 | Authenticated user is not the video's channel owner |
| `INVALID_UPLOAD_STATE` | 409 | `complete-upload` or `abort-upload` called on a video not in `uploading` status |
| `UPLOAD_NOT_FOUND` | 404 | Multipart upload ID not found in MinIO |
| `STORAGE_ERROR` | 500 | MinIO/S3 operation failed (bucket access, network) |
| `PROCESSING_FAILED` | 500 | Worker reported irrecoverable error (embedded in video status) |

### Events/Messages

#### Job: `video.process`

Published by API after `CompleteMultipartUpload` succeeds. Consumed by Video Worker.

```typescript
interface VideoProcessJob {
  videoId: number;
  storageBucket: string;
  storageKey: string;
}
```

#### Job Events (BullMQ)

| Event | Direction | Purpose |
|-------|-----------|---------|
| `video.process` | API → Worker | Trigger metadata extraction and thumbnail generation |
| `completed` | Worker → Queue | Job succeeded; worker already set status to `ready` |
| `failed` | Worker → Queue | Job failed after retries; worker sets status to `error` |
| `progress` | Worker → Queue | Optional progress updates during processing |

---

## Step Implementations

### SI-03.1 — Infrastructure: Docker Compose, Dependencies, and Configuration

**Description:** Add Redis, MinIO, and Video Worker services to `compose.yaml`. Create `storage` and `queue` config namespaces. Install all Phase 03 dependencies. Extend the Joi validation schema. Create the worker Dockerfile with FFmpeg.

**Technical actions:**

- Add Redis service to `compose.yaml` — image `redis:7-alpine`, port `6379`, healthcheck with `redis-cli ping`
- Add MinIO service to `compose.yaml` — image `minio/minio:latest`, ports `9000` (API) and `9001` (Console), environment `MINIO_ROOT_USER=minioadmin`, `MINIO_ROOT_PASSWORD=minioadmin`, volume `minio_data:/data`, command `server /data --console-address ":9001"`, healthcheck
- Add Video Worker service to `compose.yaml` — build from `worker.Dockerfile`, depends on `db`, `redis`, `minio`, volumes `.:/home/node/app`, environment inheriting from `.env`
- Create `worker.Dockerfile` — extends `node:22-alpine`, installs `ffmpeg` via `apk add ffmpeg`, copies app, runs `node dist/worker/main.worker.js`
- Install dependencies: `bullmq@^5.79.3`, `@nestjs/bullmq@^11.0.4`, `ioredis@^5.11.1`, `@aws-sdk/client-s3@^3.846.0`, `@aws-sdk/s3-request-presigner@^3.848.0`, `nanoid@^5.1.6`, `fluent-ffmpeg@^2.1.3`, `@types/fluent-ffmpeg@^2.1.0`
- Create `src/config/storage.config.ts` — `registerAs('storage', ...)` reading `STORAGE_ENDPOINT` (string, default `'minio'`), `STORAGE_PORT` (number, default `9000`), `STORAGE_USE_SSL` (boolean, default `false`), `STORAGE_ACCESS_KEY` (string, default `'minioadmin'`), `STORAGE_SECRET_KEY` (string, default `'minioadmin'`), `STORAGE_BUCKET` (string, default `'streamtube-videos'`), `STORAGE_REGION` (string, default `'us-east-1'`)
- Create `src/config/queue.config.ts` — `registerAs('queue', ...)` reading `REDIS_HOST` (string, default `'redis'`), `REDIS_PORT` (number, default `6379`)
- Update `src/config/env.validation.ts` — add storage and queue env vars to Joi schema
- Update `.env` and `.env.example`

**Dependencies:** None

**Acceptance criteria:**
- `docker compose up -d` starts all services (API, DB, Mailpit, Redis, MinIO, Worker)
- `docker compose exec nestjs-api npm test` passes (existing suite, no regressions)
- Application starts without errors; missing storage/queue env vars use defaults

---

### SI-03.2 — Video Entity, Migration, and VideosModule

**Description:** Create the `Video` entity with TypeORM decorators, generate the migration, and set up `VideosModule` with `TypeOrmModule.forFeature`.

**Technical actions:**

- Create `src/videos/entities/video.entity.ts` — `@Entity('videos')` with all columns per Data Model. `@ManyToOne(() => Channel)` relation. `url_hash` with `@Index()` and `unique: true`. `status` as `enum` TypeORM column. `upload_id` nullable for multipart tracking.
- Create `src/videos/videos.module.ts` — `VideosModule` with `TypeOrmModule.forFeature([Video])`.
- Generate migration: `npm run migration:generate -- src/database/migrations/CreateVideos`
- Register `VideosModule` in `src/app.module.ts`
- Create `src/videos/videos.service.ts` — inject `Repository<Video>`, implement `create(dto)`, `findByUrlHash(urlHash)`, `findByChannelId(channelId)`, `updateStatus(id, status, errorMessage?)`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/entities/video.entity.integration-spec.ts` | Integration | Unique url_hash constraint, status enum values, channel relation, nullable columns, timestamps |
| `src/videos/videos.module.spec.ts` | Unit | Module compiles with TypeOrmModule wiring |

**Dependencies:** SI-03.1

**Acceptance criteria:**
- `npm run migration:run` creates `videos` table with all columns, constraints, and indexes
- Inserting a video with a duplicate `url_hash` fails with unique constraint violation
- Status defaults to `'draft'` on insert
- Video is linked to a channel via `channel_id` FK

---

### SI-03.3 — Storage Module (MinIO/S3)

**Description:** Create `StorageModule` with `StorageService` wrapping the AWS SDK v3 S3 client, configured for MinIO. Implement multipart upload orchestration, presigned URL generation, and range-based GetObject.

**Technical actions:**

- Create `src/storage/storage.module.ts` — `StorageModule` with `S3Client` provider configured via `storageConfig` with `endpoint`, `region`, `credentials`, `forcePathStyle: true`. Register `StorageService`. Make module `@Global()`.
- Create `src/storage/storage.service.ts`:
  - `ensureBucket(bucket: string): Promise<void>` — creates bucket if it doesn't exist
  - `createMultipartUpload(bucket: string, key: string, contentType: string): Promise<string>` — returns `uploadId`
  - `generatePresignedPartUrls(bucket: string, key: string, uploadId: string, partCount: number, expiresIn: number): Promise<{partNumber: number, url: string}[]>`
  - `completeMultipartUpload(bucket: string, key: string, uploadId: string, parts: {partNumber: number, etag: string}[]): Promise<void>`
  - `abortMultipartUpload(bucket: string, key: string, uploadId: string): Promise<void>`
  - `getObjectStream(bucket: string, key: string, range?: string): Promise<{stream: Readable, contentType: string, contentLength: number, contentRange?: string}>`
  - `generatePresignedDownloadUrl(bucket: string, key: string, expiresIn: number, filename: string): Promise<string>`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/storage/storage.service.integration-spec.ts` | Integration | Bucket creation, multipart lifecycle (create → presigned URLs → complete), GetObject with Range, presigned download URL |
| `src/storage/storage.module.spec.ts` | Unit | Module compiles with S3Client provider wiring |

**Dependencies:** SI-03.1

**Acceptance criteria:**
- Bucket is auto-created on first use
- Multipart upload lifecycle: create → generate presigned URLs → complete returns successfully
- Aborting a multipart upload cleans up incomplete parts in MinIO
- GetObject with `Range: bytes=0-1023` returns only the first 1024 bytes
- Presigned download URL is valid for the specified duration

---

### SI-03.4 — Queue Module (BullMQ)

**Description:** Create `QueueModule` with BullMQ registration connected to Redis. Define the `video.process` job. Create a `VideoProcessor` placeholder (the real processor lives in the worker). Implement job enqueue in a service.

**Technical actions:**

- Create `src/queue/queue.module.ts` — import `BullModule.forRootAsync` with Redis connection from `queueConfig`. Register `BullModule.registerQueue({ name: 'video' })`. Export `BullModule`.
- Create `src/queue/queue.service.ts` — inject `@InjectQueue('video')`, implement `addProcessVideoJob(videoId: number, storageBucket: string, storageKey: string): Promise<Job<VideoProcessJob>>`
- Export queue-related types: `VideoProcessJob` interface in `src/queue/queue.types.ts`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/queue/queue.service.integration-spec.ts` | Integration | Job is enqueued to Redis, appears in Bull Board, can be retrieved by job ID |
| `src/queue/queue.module.spec.ts` | Unit | Module compiles with BullModule wiring |

**Dependencies:** SI-03.1

**Acceptance criteria:**
- `addProcessVideoJob` returns a job with status `waiting` or `active`
- Queue is visible in Bull Board at `/admin/queues` (optional — if Bull Board is registered)

---

### SI-03.5 — Video Upload Endpoints

**Description:** Implement the upload orchestration endpoints: initiate (create draft + presigned URLs), complete (finish multipart + enqueue processing), and abort (clean up + delete draft). Enforce authorization.

**Technical actions:**

- Create `src/videos/videos.controller.ts` with endpoints:
  - `POST /videos/initiate-upload` — validates DTO, generates `url_hash` via `nanoid()`, creates Video in `draft` status with `upload_id`, generates `STORAGE_KEY` as `videos/{urlHash}/{fileName}`, calls `StorageService.createMultipartUpload` + `generatePresignedPartUrls`, returns video + presigned URLs
  - `POST /videos/:id/complete-upload` — validates DTO, verifies video owner, verifies status is `uploading`, calls `StorageService.completeMultipartUpload`, updates status to `processing`, enqueues `video.process` job
  - `POST /videos/:id/abort-upload` — verifies owner, calls `StorageService.abortMultipartUpload`, deletes video row
- Create DTOs:
  - `src/videos/dto/initiate-upload.dto.ts` — `fileName` (string), `fileSize` (number, min 1), `mimeType` (string), `partCount` (number, min 1, max 10000)
  - `src/videos/dto/complete-upload.dto.ts` — `parts` (array of `{ partNumber: number, etag: string }`)
- Register `VideosController` in `VideosModule`. Ensure JWT guard applies (global from Phase 02). Use `@Public()` for streaming/download endpoints (SI-03.6).
- Add ownership guard: create `src/videos/guards/video-owner.guard.ts` or verify ownership in service. Use `Channel` relation: `video.channel.user_id === currentUser.id`.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | Initiate creates draft with url_hash, status, upload_id. Complete transitions to processing. Abort cleans up. Non-owner is rejected. Invalid state transitions rejected. |
| `src/videos/videos.service.integration-spec.ts` | Integration | Full upload lifecycle: initiate → complete → video in DB with correct status. Abort removes video. |

**Dependencies:** SI-03.2, SI-03.3, SI-03.4

**Acceptance criteria:**
- `POST /videos/initiate-upload` returns 201 with video (status `draft`) + presigned URLs + upload ID
- `POST /videos/:id/complete-upload` returns 200 with video (status `processing`) and a job is enqueued
- `POST /videos/:id/abort-upload` returns 204; video row is deleted from DB
- Non-owner calling `complete-upload` or `abort-upload` gets 403
- Calling `complete-upload` on a video in `draft` (not `uploading`) gets 409

---

### SI-03.6 — Video Streaming and Download Endpoints

**Description:** Implement the streaming endpoint with HTTP Range request support (206 Partial Content) proxying to MinIO, and the download endpoint with Content-Disposition. Both are public (no auth required).

**Technical actions:**

- Add to `VideosController`:
  - `GET /videos/:urlHash/stream` — `@Public()`. Looks up video by `url_hash`. Verifies status is `ready`. Reads `Range` header. Calls `StorageService.getObjectStream` with range. Sets response headers: `Content-Type`, `Accept-Ranges: bytes`, `Content-Range` (if range), `Content-Length`. Returns `StreamableFile`. Sets status 206 if Range present, 200 otherwise.
  - `GET /videos/:urlHash/download` — `@Public()`. Looks up video by `url_hash`. Verifies status is `ready`. Calls `StorageService.getObjectStream` (no range). Sets `Content-Disposition: attachment; filename="{original filename}"`, `Content-Type: application/octet-stream`. Returns `StreamableFile`.
- Use `@Res({ passthrough: true })` to set headers manually while letting NestJS handle the stream.
- Handle `Range` header parsing: support `bytes=0-`, `bytes=N-M`, `bytes=-N` formats. Default chunk size: 1MB when range end is unspecified.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.controller.stream.spec.ts` | Unit | Range header parsing, correct response headers for 206/200, correct passthrough behavior |

**Dependencies:** SI-03.2, SI-03.3, SI-03.5

**Acceptance criteria:**
- `GET /videos/:urlHash/stream` without Range header returns 200 with full video
- `GET /videos/:urlHash/stream` with `Range: bytes=0-1048575` returns 206 with `Content-Range` header
- `GET /videos/:urlHash/download` returns 200 with `Content-Disposition: attachment` header
- Non-ready videos return 404 for both endpoints
- Non-existent `urlHash` returns 404

---

### SI-03.7 — Video Worker (Standalone NestJS App)

**Description:** Create the Video Worker as a standalone NestJS application (`createApplicationContext`) that consumes `video.process` jobs. Extract metadata via ffprobe, generate a thumbnail via ffmpeg, upload both to MinIO, and update the video row in the database.

**Technical actions:**

- Create `src/worker/main.worker.ts` — bootstrap via `NestFactory.createApplicationContext(WorkerModule)`
- Create `src/worker/worker.module.ts` — imports `BullModule.forRootAsync`, `BullModule.registerQueue({ name: 'video' })`, `ConfigModule`, `TypeOrmModule.forFeature([Video])`, `StorageModule`. Registers `VideoProcessor`.
- Create `src/worker/video.processor.ts` — `@Processor('video')` class:
  - `@Process()` handler `processVideo(job: Job<VideoProcessJob>)`:
    1. Set video status to `processing` (redundant safe guard — API already sets it)
    2. Download video file from MinIO to temp local path via `getObjectStream` piped to `fs.createWriteStream`
    3. Extract metadata via `fluent-ffmpeg.ffprobe`: duration, width, height, codec, bitrate
    4. Calculate thumbnail timestamp (10% of duration or 5s, whichever is smaller)
    5. Generate thumbnail via `fluent-ffmpeg.screenshots({ timestamps: [thumbTime], filename: 'thumbnail.png', size: '1280x720' })`
    6. Upload thumbnail to MinIO at `videos/{urlHash}/thumbnail.png`
    7. Update video row: set `duration_seconds`, `width`, `height`, `codec`, `bitrate_bps`, `thumbnail_storage_key`, `file_size_bytes`, and status `ready`
    8. Clean up temp files
  - Error handling: catch + set status `error` with `error_message` from exception
- Update `worker.Dockerfile`: ensure FFmpeg is available (verify with `ffmpeg -version` on start)
- Add worker npm script: `"start:worker": "node dist/worker/main.worker.js"`
- Update `nest-cli.json` to include worker entry point in build

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/worker/video.processor.spec.ts` | Unit | Processor handles job, updates DB on success, sets error on failure |
| `src/worker/video.processor.integration-spec.ts` | Integration | Full processing cycle with real MinIO + FFmpeg: download, probe, thumbnail, upload, DB update |

**Dependencies:** SI-03.3, SI-03.4, SI-03.5

**Acceptance criteria:**
- Worker boots without HTTP server (`NestFactory.createApplicationContext`)
- `video.process` job is consumed and processed
- After successful processing: video status is `ready`, `duration_seconds` is set, `thumbnail_storage_key` is set, thumbnail exists in MinIO
- After FFmpeg failure: video status is `error`, `error_message` is set

---

### SI-03.8 — E2E Tests for Video Workflows

**Description:** Write E2E tests covering the full upload orchestration + streaming + download flows, and error cases.

**Technical actions:**

- Create `test/videos.e2e-spec.ts`:
  - **Setup:** create test user + channel, obtain auth tokens
  - **Happy path — upload orchestration:**
    1. `POST /videos/initiate-upload` → 201, returns presigned URLs, video in `draft`
    2. Upload parts to presigned URLs (direct MinIO calls using S3 client)
    3. `POST /videos/:id/complete-upload` → 200, video in `processing`
    4. Wait for worker or simulate status update → video in `ready`
  - **Streaming:**
    5. `GET /videos/:urlHash/stream` → 200, returns video bytes
    6. `GET /videos/:urlHash/stream` with `Range: bytes=0-1023` → 206, returns 1024 bytes
  - **Download:**
    7. `GET /videos/:urlHash/download` → 200, `Content-Disposition: attachment`
  - **Authorization:**
    8. `POST /videos/initiate-upload` without auth → 401
    9. `POST /videos/:id/complete-upload` as different user → 403
  - **Error cases:**
    10. `GET /videos/nonexistent/stream` → 404
    11. `POST /videos/:id/complete-upload` on a non-uploading video → 409

**Dependencies:** SI-03.5, SI-03.6, SI-03.7

**Acceptance criteria:**
- All E2E test cases pass (`npm run test:e2e`)
- No cross-test contamination (tests clean up after themselves)

---

### SI-03.9 — TypeScript Compilation and Lint Fixes

**Description:** Ensure `npx tsc --noEmit` exits with code 0 and `npm run lint` passes. Fix any type errors or lint violations introduced across all SIs.

**Technical actions:**

- Run `npx tsc --noEmit` and fix all compilation errors
- Run `npm run lint` and fix all ESLint errors/warnings
- Verify full test suite passes: `npm test -- --runInBand` + `npm run test:e2e`

**Dependencies:** All preceding SIs

**Acceptance criteria:**
- `npx tsc --noEmit` exits with code 0
- `npm run lint` exits with code 0
- Full test suite is green

---

## Dependency Map

```
SI-03.1 (Infrastructure + Dependencies)
  ├── SI-03.2 (Video Entity + Migration)
  │     ├── SI-03.5 (Upload Endpoints)
  │     │     ├── SI-03.6 (Streaming + Download)
  │     │     └── SI-03.9 (TS + Lint)
  │     └── SI-03.3 (Storage Module)
  │           ├── SI-03.5 (Upload Endpoints)
  │           ├── SI-03.6 (Streaming + Download)
  │           └── SI-03.7 (Video Worker)
  ├── SI-03.4 (Queue Module)
  │     ├── SI-03.5 (Upload Endpoints)
  │     └── SI-03.7 (Video Worker)
  └── SI-03.8 (E2E Tests) — depends on SI-03.5, SI-03.6, SI-03.7
```

## Deliverables

| Artifact | Location | SI |
|----------|----------|-----|
| Docker Compose (Redis, MinIO, Worker) | `nestjs-project/compose.yaml` | SI-03.1 |
| Worker Dockerfile | `nestjs-project/worker.Dockerfile` | SI-03.1 |
| Config namespaces (storage, queue) | `src/config/storage.config.ts`, `src/config/queue.config.ts` | SI-03.1 |
| Env validation (extended) | `src/config/env.validation.ts` | SI-03.1 |
| Video entity | `src/videos/entities/video.entity.ts` | SI-03.2 |
| Migration | `src/database/migrations/<timestamp>-CreateVideos.ts` | SI-03.2 |
| Videos module + service | `src/videos/videos.module.ts`, `src/videos/videos.service.ts` | SI-03.2 |
| Storage module + service | `src/storage/storage.module.ts`, `src/storage/storage.service.ts` | SI-03.3 |
| Queue module + service | `src/queue/queue.module.ts`, `src/queue/queue.service.ts` | SI-03.4 |
| Video DTOs | `src/videos/dto/` | SI-03.5 |
| Videos controller | `src/videos/videos.controller.ts` | SI-03.5, SI-03.6 |
| Worker app + processor | `src/worker/main.worker.ts`, `src/worker/worker.module.ts`, `src/worker/video.processor.ts` | SI-03.7 |
| E2E tests | `test/videos.e2e-spec.ts` | SI-03.8 |
| Unit + integration tests | Alongside each source file | SI-03.2–SI-03.7 |
| Progress tracking | `docs/phases/phase-03-videos/progress.md` | All SIs |
