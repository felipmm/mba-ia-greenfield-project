---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-04-08T14:58:57-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-29T00:00:00-03:00"
  docs/decisions/technical-decisions-phase-01-configuracao-base.md: "2026-05-12T12:21:12-03:00"
  docs/decisions/technical-decisions-phase-02-auth.md: "2026-05-12T12:23:19-03:00"
  docs/phases/phase-02-auth/phase-02-auth.md: "2026-05-12T12:23:19-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities**

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** Edição de informações do vídeo, visibilidade (público/unlisted), publicação, painel de gerenciamento do canal, página pública do canal, player de vídeo com frontend, comentários, likes, inscrições. Todas essas capacidades pertencem às Fases 04+.

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/`

**Sequencing notes:** Depends on Fase 01 (Configuração Base) and Fase 02 (Cadastro, Login e Gerenciamento de Conta).

**Neighbors (for boundary detection only):** Fase 02 (prior), Fase 04 — Gerenciamento de Vídeos e Canal (next).

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Backend | Message Queue Technology | decided | BullMQ + Redis | bullmq@^5.x, @nestjs/bullmq@^11.x, ioredis@^5.x |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Backend | Upload Strategy for 10GB Files | decided | S3 Multipart with Presigned URLs | @aws-sdk/client-s3@^3.x, @aws-sdk/s3-request-presigner@^3.x |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Backend | Worker Architecture & FFmpeg | decided | NestJS Standalone + BullMQ Worker | fluent-ffmpeg@^2.x, @types/fluent-ffmpeg@^2.x |
| phase-03-videos/TD-04 | technical-decisions-phase-03-videos.md | Backend | URL Uniqueness Strategy | decided | Nano ID (21 chars) | nanoid@^5.x |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Backend | Video Streaming Strategy | decided | API-proxied HTTP Range Requests | @aws-sdk/client-s3@^3.x |
| phase-03-videos/TD-06 | technical-decisions-phase-03-videos.md | Backend | Video Status Lifecycle | decided | Linear: draft → uploading → processing → ready / error | — |

_Source files:_

- `docs/decisions/technical-decisions-phase-03-videos.md`

## Capability Coverage

| Capability | Covered by |
|------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-02 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-06 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-03 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-03 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-04 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-05 |
| Download do vídeo pelo usuário | phase-03-videos/TD-05 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** BullMQ + Redis — Best NestJS integration (`@nestjs/bullmq`), rich feature set (retries, backoff, scheduling, job events), production-grade monitoring via Bull Board, sub-millisecond Redis-backed dispatch. Redis is a lightweight addition to the compose file (~30MB RAM). PgBoss avoids Redis but at the cost of polling latency and no NestJS-native integration. RabbitMQ is overengineered for a single linear pipeline.

**Libraries:** `bullmq@^5.x`, `@nestjs/bullmq@^11.x`, `ioredis@^5.x`

### phase-03-videos/TD-02

**Recommendation:** S3 Multipart Upload with Presigned URLs — The API orchestrates the multipart lifecycle (`CreateMultipartUpload` → presigned URLs → `CompleteMultipartUpload`) without ever touching file bytes. The client uploads directly to MinIO in 5MB+ parts. This is the cleanest separation of concerns and definitively satisfies the "não travar o sistema" constraint.

**Libraries:** `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`

### phase-03-videos/TD-03

**Recommendation:** NestJS Standalone Application as BullMQ Worker — A separate NestJS application (`createApplicationContext`, no HTTP server) that shares entities, config, and TypeORM with the main API. Runs in a dedicated Docker container with FFmpeg installed. FFmpeg/ffprobe invoked as child processes via `fluent-ffmpeg`.

**Libraries:** `fluent-ffmpeg@^2.x`, `@types/fluent-ffmpeg@^2.x`

### phase-03-videos/TD-04

**Recommendation:** Nano ID (21 characters, default alphabet) — Compact (21 chars vs UUID's 36), URL-safe (`A-Za-z0-9_-`), cryptographically secure (~126 bits entropy). Stored in a `url_hash` varchar column with a unique index. Database primary key remains auto-increment integer, consistent with existing User/Channel entities.

**Libraries:** `nanoid@^5.x`

### phase-03-videos/TD-05

**Recommendation:** API-proxied HTTP Range Requests (206 Partial Content) — The API parses the `Range` header, forwards it to MinIO via `GetObjectCommand` with the `Range` parameter, and pipes the response. Browser `<video>` element works natively with seek support. Access control enforced through the API layer. No transcoding infrastructure needed for Phase 03.

**Libraries:** `@aws-sdk/client-s3@^3.x` (same as TD-02)

### phase-03-videos/TD-06

**Recommendation:** Linear status flow — Five states: `draft` → `uploading` → `processing` → `ready` | `error`, with an `error_message` column for failure details. Forward-compatible with Phase 04's publication/visibility fields.

**Libraries:** —

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, zero custom wiring, native string-to-number coercion.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — Clear file boundaries per domain, typed injection via `ConfigType<typeof xxxConfig>`, natural scalability.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — `data-source.ts` imports the factory, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — OWASP-recommended for new projects. Native build dependency is a one-time Docker setup cost.

**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Custom guards with @nestjs/jwt only — Keeps the dependency surface smaller; social login is not on the near-term roadmap.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Refresh Token Rotation — Strongest security model with automatic theft detection. DB write overhead acceptable for a video platform.

**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Random Opaque Tokens in DB — Revocability; DB table is trivial to implement and can serve future needs.

**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** @nestjs-modules/mailer — Best NestJS integration, supports SMTP, works with Mailpit for local dev.

**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** class-validator + class-transformer — Documented NestJS approach; project already uses decorators extensively.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Custom Domain Exception Filter — Machine-readable error codes that the frontend can switch on.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** @nestjs/throttler — Native NestJS integration; guard system allows scoping to specific modules.

**Libraries:** `@nestjs/throttler@^6.x`

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts. _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options including `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_
- Entities use TypeORM decorators with auto-increment integer primary keys (`@PrimaryGeneratedColumn`). _(from phase 02)_
- Migrations are versioned with timestamps and run via `typeorm-ts-node-commonjs`. _(from phase 01)_
- Global JWT guard (`APP_GUARD`) with `@Public()` decorator for exempting endpoints. _(from phase 02)_
- Domain exceptions use custom filter returning `{ statusCode, error, message }`. _(from phase 02)_
- Rate limiting via `@nestjs/throttler` with `ThrottlerGuard`. _(from phase 02)_
- All Docker services communicate via Compose service names as hosts — never `localhost`. _(from phase 01)_
- Tests use suffixes: `*.spec.ts` (unit), `*.integration-spec.ts` (integration with DB), `*.e2e-spec.ts` (full HTTP via supertest). _(from phase 02)_
- Integration and E2E tests run with `--runInBand` to avoid FK violations. _(from phase 02)_

## Inherited Deferred Capabilities

_No inherited deferred capabilities._

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|------------|--------|-----------|---------|
| Frontend de upload (progresso, seleção de arquivo) | deferred | `next-frontend/` UI surfaces para upload serão tratadas na Fase 05. Esta fase entrega apenas os endpoints da API. | — |
| Player de vídeo com frontend | deferred | Pertence à Fase 05 — Página de Visualização do Vídeo. | — |
| Edição de informações do vídeo e visibilidade | deferred | Pertence à Fase 04 — Gerenciamento de Vídeos e Canal. | — |

## Testing Requirements

Refer to the `testing-guide-nestjs-project` Skill for layer requirements per artifact type in `nestjs-project/`. Phase 03 introduces the Videos module with entities, DTOs, services, controllers, queue processors, and new infrastructure — each layer is exercised by unit, integration, and E2E tests per the testing guide's pyramid. Specific layer coverage by SI is recorded in `progress.md`.
