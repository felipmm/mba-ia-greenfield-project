---
kind: phase
name: phase-03-videos
---

# phase-03-videos — Library References

Libraries introduced in this phase, confirmed via npm registry and context7 documentation lookup.

## Runtime Dependencies

| Library | Version | Purpose | Notes |
|---------|---------|---------|-------|
| `bullmq` | `^5.79.3` | Job queue (Redis-backed) | Latest v5 as of Jul 2026. Requires Redis. |
| `@nestjs/bullmq` | `^11.0.4` | NestJS integration for BullMQ | NestJS 11 compatible. `@Processor()`, `@InjectQueue()` decorators. |
| `ioredis` | `^5.11.1` | Redis client for Node.js | Required by BullMQ. Latest v5 as of Jun 2026. |
| `@aws-sdk/client-s3` | `^3.846.0` | AWS SDK v3 S3 client | Compatible with MinIO (S3 API). Multipart upload, GetObject with Range. |
| `@aws-sdk/s3-request-presigner` | `^3.848.0` | Presigned URL generation | `getSignedUrl()` for presigned PUT/GET URLs. |
| `nanoid` | `^5.1.6` | URL-safe unique ID generation | 21-char default, ~126 bits entropy. |
| `fluent-ffmpeg` | `^2.1.3` | FFmpeg/ffprobe Node.js wrapper | **Deprecated upstream (May 2025)** but functional for basic ffprobe + thumbnail extraction. Monitor maintained forks (`@renmu/fluent-ffmpeg`, `fluent-ffmpeg-new`) for migration. |

## Dev Dependencies

| Library | Version | Purpose |
|---------|---------|---------|
| `@types/fluent-ffmpeg` | `^2.1.0` | TypeScript types for fluent-ffmpeg |

## Infrastructure (Docker)

| Service | Image | Purpose |
|---------|-------|---------|
| Redis | `redis:7-alpine` | Backing store for BullMQ |
| MinIO | `minio/minio:latest` | S3-compatible object storage |
| FFmpeg | Installed via `apt` in worker Dockerfile | Video processing (ffprobe + ffmpeg) |

## Notes

- **MinIO SDK vs AWS SDK**: The `@aws-sdk/client-s3` works with MinIO by setting a custom `endpoint` and `forcePathStyle: true`. No MinIO-specific SDK needed.
- **fluent-ffmpeg deprecation**: The original package is deprecated due to FFmpeg 7.0 CLI output format changes. For the operations in this phase (ffprobe metadata extraction, single-frame screenshot), version 2.1.3 is sufficient. If FFmpeg 7.0+ is used in the worker image, consider migrating to `fluent-ffmpeg-new`.
- **BullMQ vs @nestjs/bull**: The `@nestjs/bull` package is for Bull (v3), not BullMQ. We use `@nestjs/bullmq` for BullMQ v5.
