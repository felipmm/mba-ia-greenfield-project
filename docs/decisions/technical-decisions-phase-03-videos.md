---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-07-29
scope_description: "Upload and video processing infrastructure: message queue for async processing, large file upload strategy, FFmpeg worker architecture, URL uniqueness, HTTP streaming, and video status lifecycle."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that receives the Videos module, the new infrastructure services (MinIO, Redis, worker), and all video-related endpoints (upload orchestration, streaming, download).

---

## TD-01: Message Queue Technology for Video Processing

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The architecture diagram specifies a "Message Queue (TBD)" between the API and the Video Worker. After a video is uploaded, the API publishes a processing job; the worker consumes it, runs FFmpeg/ffprobe, and updates the database. The queue must be reliable (no lost jobs), support retries, and run in Docker Compose with minimal operational overhead.

**Options:**

### Option A: BullMQ + Redis
- BullMQ is the de-facto Node.js task queue built on Redis. Provides job prioritization, delayed/scheduled jobs, exponential backoff retries, parent-child job flows, and rate limiting. `@nestjs/bullmq` offers first-class NestJS integration including `@Processor()` and `@InjectQueue()` decorators. Bull Board provides a polished web UI for monitoring.
- **Pros:** First-class NestJS integration (`@nestjs/bullmq`), rich feature set (retries, backoff, scheduling), production-grade monitoring UI, Redis-backed — sub-millisecond job dispatch. Active community, widely adopted in the NestJS ecosystem. TypeScript-native API.
- **Cons:** Requires Redis — a new infrastructure service not currently in the compose file. If Redis goes down, job processing stops (mitigated by Redis persistence config). Adds one new dependency to the stack.

### Option B: PgBoss (PostgreSQL-native job queue)
- PgBoss runs entirely on PostgreSQL — no additional infrastructure. Provides at-least-once delivery, retries with backoff, scheduled jobs, and job deduplication. Its killer feature is atomic enqueue in DB transactions: you can insert the video row and enqueue the processing job in a single transaction.
- **Pros:** Zero new infrastructure — uses the existing PostgreSQL. ACID transactional enqueue eliminates the dual-write problem (video row + job must both succeed or both roll back). Lower operational complexity for small-to-medium workloads. Good enough throughput for a video platform (hundreds of jobs/minute).
- **Cons:** Higher job pickup latency (tens of ms polling vs sub-ms Redis pub/sub). Less mature NestJS integration (no `@nestjs/pgboss` — must use `pg-boss` directly). No built-in monitoring UI. Polling-based architecture adds DB load.

### Option C: RabbitMQ
- RabbitMQ is an enterprise-grade message broker supporting AMQP 0-9-1. Provides sophisticated routing via exchanges (direct, topic, fanout, headers), message persistence, dead letter exchanges, and clustering. Polyglot — producers/consumers can be written in any language.
- **Pros:** Industry-standard broker, battle-tested at massive scale. Sophisticated routing patterns (topic exchanges for different processing stages). Built-in management UI. Language-agnostic — useful if workers were ever rewritten in Go/Rust.
- **Cons:** Highest operational complexity — requires Erlang runtime, cluster configuration, and more RAM/CPU than Redis. Overkill for a single-queue, single-consumer scenario (API → queue → worker). NestJS integration requires `@nestjs/microservices` with AMQP transport — more boilerplate than BullMQ. Introducing a heavyweight broker for a simple linear pipeline violates the "start simple" principle.

**Recommendation:** **Option A (BullMQ + Redis)** — BullMQ provides the best NestJS integration, an excellent monitoring UI via Bull Board, and a rich feature set (retries, scheduling, job events) that maps directly to video processing needs. Redis is a lightweight addition to the compose file (~30MB RAM) and is justified by the real benefits: sub-millisecond dispatch, real-time progress events, and a polished developer experience. PgBoss avoids Redis but at the cost of polling latency and no NestJS-native integration. RabbitMQ is overengineered for a single linear pipeline.

**Decision:** A (BullMQ + Redis)

**Libraries:** `bullmq@^5.x`, `@nestjs/bullmq@^11.x`, `ioredis@^5.x`

---

## TD-02: Upload Strategy for Large Files (up to 10GB)

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** The API must accept video uploads up to 10GB without blocking the event loop, consuming excessive memory, or timing out. Passing the entire file through the NestJS API (multipart/form-data) would exhaust memory and tie up an HTTP connection for minutes. The architecture diagram shows the API uploading to Object Storage — the decision is HOW the bytes get there.

**Options:**

### Option A: S3 Presigned URLs (multipart upload orchestrated by the API)
- The API generates presigned PUT URLs for MinIO. The client uploads directly to MinIO in parts using the S3 Multipart Upload API (5MB+ per part). The API orchestrates the lifecycle: `CreateMultipartUpload` → generate N presigned URLs (one per part) → client uploads all parts directly → client notifies API → API calls `CompleteMultipartUpload`. The API never sees the file bytes.
- **Pros:** API stays lightweight — it only handles small JSON orchestration requests. Zero memory pressure from file uploads. Built-in MinIO/S3 feature — no custom chunking protocol. Resumable: failed parts can be re-uploaded individually. Clients can show per-part progress. MinIO presigned URLs work natively with the `@aws-sdk/client-s3` and MinIO SDK.
- **Cons:** More complex client-side logic (must split the file, upload parts, track progress). Requires frontend coordination (but frontend is out of scope for this phase — endpoints must still be designed). Presigned URL expiration (default 1h) must be generous enough for large uploads over slow connections.

### Option B: Multipart/form-data through the API with streaming to MinIO
- The client sends `multipart/form-data` to the API. The API pipes the stream directly to MinIO via `PutObject` without buffering the entire file in memory. NestJS supports this via `@UploadedFile()` with a file interceptor and streaming libraries.
- **Pros:** Simple client contract — standard HTML form upload. Single endpoint handles everything. NestJS has built-in support via `multer`/`busboy`.
- **Cons:** The API still proxies 10GB per upload — even if not buffered in memory, it ties up an HTTP connection and a Node.js thread for the entire upload duration (minutes on slow connections). The `body-parser` size limit must be raised to 10GB, creating a DoS vector. Timeouts must be configured across the reverse proxy, Express, and NestJS. This is the "passar o arquivo inteiro pela API" anti-pattern flagged in the exercise requirements — it fails the non-blocking constraint.

### Option C: TUS protocol (resumable uploads)
- TUS is an open protocol for resumable file uploads built on HTTP. The client sends `PATCH` requests with upload offsets. The server can be configured to forward chunks to S3/MinIO or store them locally. `tus-node-server` provides a protocol-compliant server.
- **Pros:** Resumable uploads out of the box — connection drops don't lose progress. Standard protocol with client libraries in many languages. Designed for large files.
- **Cons:** Adds protocol complexity and a dedicated server dependency. TUS server still proxies bytes (same problem as Option B at high scale). Less S3-native — chunks must be assembled before handing off to MinIO. Overengineered for a platform where uploads happen over reliable connections (not mobile-first).

**Recommendation:** **Option A (S3 Multipart Upload with Presigned URLs)** — This is the cleanest separation of concerns: the API orchestrates without touching file bytes, MinIO handles storage natively, and the client gets per-part progress. It satisfies the "não travar o sistema" constraint definitively — the API's job is a few JSON round-trips, not a 10GB proxy. The frontend complexity (splitting files, tracking parts) is deferred to Phase 05 (Página de Visualização) when the upload UI is built; for Phase 03, the API endpoints and the multipart orchestration logic are the deliverable.

**Decision:** A (S3 Multipart with Presigned URLs)

**Libraries:** `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`

---

## TD-03: Video Worker Architecture and FFmpeg Integration

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** After upload completes, videos must be processed: extract duration and metadata (codec, resolution, bitrate) via ffprobe, and generate a thumbnail from a frame (e.g., at 10% of duration) via FFmpeg. This work is CPU-intensive and must run asynchronously in a separate container — the worker that consumes from the queue (TD-01). The architecture diagram labels this container "Video Worker (FFmpeg)".

**Options:**

### Option A: BullMQ Worker in a dedicated NestJS Standalone Application
- Create a separate NestJS application (no HTTP server) in `nestjs-project/src/worker/` that boots as a BullMQ worker. It shares the same TypeORM entities and config as the main API, reusing `databaseConfig`, `AppModule` patterns, and entity classes. `main.worker.ts` calls `NestFactory.createApplicationContext(WorkerModule)`. Launched via a separate Docker Compose service with `command: node dist/worker/main.worker.js`.
- **Pros:** Shares code with the API — entities, config, services can be imported directly. Same dependency injection, logging, and error handling patterns. BullMQ `@Processor()` decorator provides clean job handler definition. TypeScript compilation is shared — no separate toolchain. NestJS standalone context is lightweight (no HTTP layer).
- **Cons:** Requires compiling the worker separately (or sharing the build). Docker image is the same as the API — includes unnecessary HTTP dependencies. Worker must wait for the full NestJS DI bootstrap on each restart.

### Option B: Pure Node.js script with BullMQ + direct FFmpeg subprocess
- A plain Node.js script that imports `bullmq`, `fluent-ffmpeg`, the MinIO SDK, and `pg` directly. No NestJS DI. Launched as a simple `node worker.js` in a dedicated Docker container with FFmpeg installed.
- **Pros:** Minimal dependencies — faster startup, smaller memory footprint. FFmpeg subprocess management is straightforward. No NestJS boilerplate for a task that doesn't handle HTTP.
- **Cons:** Code duplication — must reimplement DB access, config loading, and error handling that the API already has. Two different coding styles in the same repository. No sharing of TypeORM entities or services. Harder to test with the project's Jest conventions.

### Option C: NestJS BullMQ Worker integrated into the main API process
- Register BullMQ workers (`@Processor()` classes) directly in the main API `AppModule`. The API both enqueues jobs and processes them — no separate container.
- **Pros:** Simplest setup — no separate service, no extra Dockerfile. Full code reuse.
- **Cons:** CPU-intensive FFmpeg processing competes with HTTP request handling. Video processing can degrade API responsiveness. Violates the architecture diagram which shows a separate worker container. Blocks the event loop during FFmpeg operations if not carefully managed. Rejected on architectural grounds — the Phase 03 requirements explicitly call for a separate worker.

**Recommendation:** **Option A (NestJS Standalone Application as BullMQ Worker)** — This preserves code reuse (entities, config, TypeORM) while keeping the worker isolated in its own container. The NestJS standalone context (`createApplicationContext`) boots without an HTTP server, so it's lightweight. It aligns with the architecture diagram (separate worker container) and with the project's NestJS-first philosophy. FFmpeg/ffprobe are invoked as child processes via `child_process.execFile` or `fluent-ffmpeg`, with the FFmpeg binary installed in the worker's Docker image.

**Decision:** A (NestJS Standalone Application as BullMQ Worker)

**Libraries:** `fluent-ffmpeg@^2.x`, `@types/fluent-ffmpeg@^2.x`

---

## TD-04: URL Uniqueness Strategy for Videos

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video must have a unique, URL-safe identifier for its watch page and API endpoints (e.g., `/videos/<id>`). The identifier must never collide with another video, be safe for URLs without encoding, and be reasonably short for sharing. It is separate from the database primary key.

**Options:**

### Option A: Nano ID (21 characters, URL-safe alphabet)
- Nano ID generates compact, URL-safe, cryptographically random IDs using `A-Za-z0-9_-`. At 21 characters with default alphabet, it provides ~126 bits of entropy — collision probability is negligible (1% chance after generating 10^20 IDs). Bundle size is ~130 bytes.
- **Pros:** Short, clean URLs (21 chars vs UUID's 36). Fully URL-safe — no hyphens, no encoding needed. Cryptographically secure. Customizable length and alphabet. Zero dependencies.
- **Cons:** Not a database-native type (stored as `varchar`). No sortability (random). Another dependency (though tiny).

### Option B: UUID v4 (36 characters)
- Standard RFC 4122 UUID. PostgreSQL has a native `UUID` column type. Node.js 14.17+ has built-in `crypto.randomUUID()` — zero dependencies.
- **Pros:** Industry standard, zero dependencies on Node.js side, native PostgreSQL column type, good for DB primary keys.
- **Cons:** Long (36 chars with hyphens), ugly in URLs, not optimized for sharing. The hyphens add visual noise.

### Option C: Short ID or custom short code
- Generate shorter codes (6-12 chars) from a limited alphabet. Higher collision risk at scale. Potential for guessable sequential patterns.
- **Pros:** Shortest URLs.
- **Cons:** Short ID is deprecated. Custom implementations risk collisions and predictability. Less entropy than Nano ID. Not recommended without a collision-resolution strategy.

**Recommendation:** **Option A (Nano ID)** — Nano ID produces clean, short URLs ideal for a video sharing platform where users share links. At 21 characters it's significantly shorter than UUID (21 vs 36) while maintaining cryptographic-level collision resistance. The database primary key remains a standard auto-increment integer (consistent with the project's existing User/Channel entities); the Nano ID is the public-facing identifier stored in a `url_hash` column with a unique index.

**Decision:** A (Nano ID, 21 characters)

**Libraries:** `nanoid@^5.x`

---

## TD-05: Video Streaming Strategy

**Scope:** Backend

**Capability:** Reprodução via streaming (sem necessidade de download completo)

**Context:** Viewers must be able to watch videos without downloading the entire file first. The browser's native `<video>` element requests content via HTTP Range requests. The API must proxy these requests to MinIO (where videos are stored) or serve them directly, supporting `206 Partial Content` responses so the browser can seek to any position in the video.

**Options:**

### Option A: API-proxied HTTP Range Requests (206 Partial Content)
- The API exposes a streaming endpoint (e.g., `GET /videos/:id/stream`). It parses the `Range` header from the request, forwards it to MinIO via `GetObjectCommand` with the `Range` parameter, and pipes the response body back to the client with appropriate `Content-Range`, `Accept-Ranges`, and `Content-Length` headers.
- **Pros:** Simple — no additional infrastructure. The API can enforce access control (public/unlisted/private) before streaming. Works with any browser `<video>` element natively. MinIO/S3 natively supports range-based GETs. No transcoding needed (serve the original file).
- **Cons:** API still proxies video bytes — high bandwidth consumption. But unlike upload, this is read-only and stateless (each range request is independent). For a platform with modest traffic, this is acceptable; a CDN can be added later.

### Option B: Presigned download URLs (direct MinIO streaming)
- The API generates a time-limited presigned GET URL for the video object in MinIO and redirects the client. The client's `<video>` element streams directly from MinIO.
- **Pros:** Zero bandwidth through the API. MinIO handles all streaming natively. Simplest API code — just generate a signed URL and redirect.
- **Cons:** No access control at streaming time — the presigned URL grants access to anyone who has it for its validity window. Once the URL is generated, the API cannot revoke access mid-stream. Video visibility (unlisted/private in future phases) cannot be enforced at the storage layer. Short-lived URLs force re-authentication mid-playback.

### Option C: HLS (HTTP Live Streaming) with transcoding
- The worker transcodes each uploaded video into multiple resolutions (360p, 720p, 1080p) and segments (`.ts` files) with an `.m3u8` manifest. The client uses an HLS player library.
- **Pros:** Adaptive bitrate — adjusts quality based on connection speed. Industry standard for streaming platforms. Segments can be cached aggressively.
- **Cons:** Massive increase in storage (N resolutions × original size). Processing time multiplies — transcoding 10GB into 3 resolutions takes hours on CPU. Operational complexity of managing manifests, segments, and CDN invalidation. Overengineered for Phase 03 — adaptive streaming is a Phase 05+ concern.

**Recommendation:** **Option A (API-proxied HTTP Range Requests)** — This is the correct balance for Phase 03. It provides functional streaming (browser `<video>` element works with seek support), enforces access control through the API layer, and requires no transcoding infrastructure. Bandwidth through the API is a known trade-off that can be addressed later with a CDN or presigned redirects for public videos. HLS transcoding is a significant scope expansion that belongs in a future optimization phase.

**Decision:** A (Linear status: draft → uploading → processing → ready / error)

---

## TD-06: Video Status Lifecycle and Error Handling

**Scope:** Backend

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload; Processamento automático do vídeo após upload; Ciclo de status do vídeo (rascunho → processando → pronto/erro)

**Context:** Videos go through a defined lifecycle from upload initiation to completion. The status must be reflected in the database so the API can respond correctly to queries (list only ready videos, show processing state to the owner). Error handling must be explicit — if FFmpeg fails, the video must not be left in an ambiguous state.

**Options:**

### Option A: Linear status flow with explicit error state
- Statuses: `draft` → `uploading` → `processing` → `ready` | `error`. Transitions are strictly defined: `draft` is set when the upload is initiated (presigned URL request). `uploading` when the first part is confirmed. `processing` when the job is enqueued. `ready` when metadata extraction and thumbnail generation both succeed. `error` when any step fails, with an `error_message` column storing details.
- **Pros:** Simple, predictable state machine. Each status has a clear meaning for API consumers. The `error` state prevents silent failures — videos in error are visible to their owners. Compatible with the Phase 04 management features (edit info, publish/visibility).
- **Cons:** No retry workflow built into the status model (retries are handled by the queue, not the status). No distinction between "processing failed" and "upload incomplete" — both map to `error`.

### Option B: Extended status with sub-states
- Statuses: `draft` → `awaiting_upload` → `uploading` → `upload_complete` → `queued` → `processing` → `processing_metadata` → `processing_thumbnail` → `ready` | `error_upload` | `error_processing`. More granular tracking.
- **Pros:** Fine-grained observability — operators can see exactly where a video is in the pipeline. Easier to debug stuck videos.
- **Cons:** Overengineered for a 3-step pipeline (upload → metadata → thumbnail). Most sub-states are internal to the processing step and don't need to be exposed. Increases frontend complexity (more states to handle in the UI). Adding a sub-state later is a minor migration — no need to pre-build all of them.

### Option C: Binary status (published + processing_flag)
- A single `is_published` boolean plus a `processing_status` enum. Videos are hidden until both `is_published = true` and `processing_status = ready`.
- **Pros:** Minimal database surface. Separates "owner intent" (publish) from "system state" (processing).
- **Cons:** Phase 04 introduces visibility (public/unlisted) — conflating publication with processing would require a refactor. Less explicit than a dedicated status enum.

**Recommendation:** **Option A (Linear status with explicit error)** — The five states (`draft`, `uploading`, `processing`, `ready`, `error`) cover every observable stage in the upload-to-ready pipeline without unnecessary granularity. The `error_message` column provides debugging detail without adding states. This model is forward-compatible with Phase 04: the management UI lists videos by status, and publication/visibility is a separate field (added in Phase 04) orthogonal to processing status.

**Decision:** A (Linear status: draft → uploading → processing → ready / error)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Message Queue Technology | BullMQ + Redis | A |
| TD-02 | Backend | Upload Strategy for 10GB Files | S3 Multipart with Presigned URLs | A |
| TD-03 | Backend | Worker Architecture & FFmpeg | NestJS Standalone + BullMQ Worker | A |
| TD-04 | Backend | URL Uniqueness Strategy | Nano ID (21 chars) | A |
| TD-05 | Backend | Video Streaming Strategy | API-proxied HTTP Range Requests | A |
| TD-06 | Backend | Video Status Lifecycle | Linear status: draft → uploading → processing → ready / error | A |
