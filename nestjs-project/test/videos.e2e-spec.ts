import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { AuthService } from '../src/auth/auth.service';

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await dataSource.query('DELETE FROM "channels"');
    await dataSource.query('DELETE FROM "refresh_tokens"');
    await dataSource.query('DELETE FROM "verification_tokens"');
    await dataSource.query('DELETE FROM "users"');
    throttlerStorage.storage.clear();
  });

  async function registerAndLogin(
    email: string,
    password = 'password123',
  ): Promise<{ access_token: string; headers: Record<string, string> }> {
    const authService = app.get(AuthService);
    const mailServiceInstance = (authService as any).mailService;
    let capturedToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_e: string, _n: string, t: string) => {
        capturedToken = t;
      });

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });

    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: capturedToken });

    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });

    const accessToken = res.body.access_token as string;
    return {
      access_token: accessToken,
      headers: { Authorization: `Bearer ${accessToken}` },
    };
  }

  describe('POST /videos/initiate-upload', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app.getHttpServer())
        .post('/videos/initiate-upload')
        .send({
          fileName: 'test.mp4',
          fileSize: 1048576,
          mimeType: 'video/mp4',
          partCount: 1,
        })
        .expect(401);

      expect(res.body.message).toBeDefined();
    });

    it('returns 201 with presigned URLs for authenticated user', async () => {
      const { headers } = await registerAndLogin('uploader@test.com');

      const res = await request(app.getHttpServer())
        .post('/videos/initiate-upload')
        .set(headers)
        .send({
          fileName: 'my-video.mp4',
          fileSize: 10485760,
          mimeType: 'video/mp4',
          partCount: 1,
        })
        .expect(201);

      expect(res.body.video).toBeDefined();
      expect(res.body.video.status).toBe('uploading');
      expect(res.body.video.urlHash).toBeDefined();
      expect(res.body.uploadId).toBeDefined();
      expect(res.body.presignedUrls).toBeInstanceOf(Array);
      expect(res.body.presignedUrls.length).toBe(1);
      expect(res.body.expiresAt).toBeDefined();
    });

    it('returns 400 when partCount exceeds max', async () => {
      const { headers } = await registerAndLogin('bad@test.com');

      await request(app.getHttpServer())
        .post('/videos/initiate-upload')
        .set(headers)
        .send({
          fileName: 'test.mp4',
          fileSize: 100,
          mimeType: 'video/mp4',
          partCount: 10001,
        })
        .expect(400);
    });

    it('creates video records for different users independently', async () => {
      const u1 = await registerAndLogin('user1@test.com');
      const u2 = await registerAndLogin('user2@test.com');

      const res1 = await request(app.getHttpServer())
        .post('/videos/initiate-upload')
        .set(u1.headers)
        .send({
          fileName: 'u1.mp4',
          fileSize: 1000,
          mimeType: 'video/mp4',
          partCount: 1,
        })
        .expect(201);

      const res2 = await request(app.getHttpServer())
        .post('/videos/initiate-upload')
        .set(u2.headers)
        .send({
          fileName: 'u2.mp4',
          fileSize: 2000,
          mimeType: 'video/mp4',
          partCount: 2,
        })
        .expect(201);

      expect(res1.body.video.urlHash).not.toBe(res2.body.video.urlHash);
    });
  });

  describe('POST /videos/:id/complete-upload', () => {
    it('returns 401 without auth', async () => {
      await request(app.getHttpServer())
        .post('/videos/00000000-0000-0000-0000-000000000000/complete-upload')
        .send({ parts: [] })
        .expect(401);
    });

    it('returns 404 for non-existent video', async () => {
      const { headers } = await registerAndLogin('owner@test.com');

      await request(app.getHttpServer())
        .post('/videos/00000000-0000-0000-0000-000000000001/complete-upload')
        .set(headers)
        .send({ parts: [] })
        .expect(404);
    });
  });

  describe('POST /videos/:id/abort-upload', () => {
    it('returns 401 without auth', async () => {
      await request(app.getHttpServer())
        .post('/videos/00000000-0000-0000-0000-000000000000/abort-upload')
        .expect(401);
    });
  });

  describe('GET /videos/:urlHash/stream', () => {
    it('is public (no auth required) but returns 404 for unknown video', async () => {
      await request(app.getHttpServer())
        .get('/videos/nonexistent/stream')
        .expect(404);
    });

    it('is public (no auth required)', async () => {
      const res = await request(app.getHttpServer()).get(
        '/videos/nonexistent/stream',
      );
      expect([200, 206, 404]).toContain(res.status);
    });
  });

  describe('GET /videos/:urlHash/download', () => {
    it('is public but returns 404 for unknown video', async () => {
      await request(app.getHttpServer())
        .get('/videos/nonexistent/download')
        .expect(404);
    });
  });

  describe('Authorization', () => {
    it('returns 401 for protected endpoints without token', async () => {
      const NONEXISTENT_UUID = '00000000-0000-0000-0000-000000000000';
      const endpoints = [
        { method: 'post' as const, path: '/videos/initiate-upload', body: {} },
        {
          method: 'post' as const,
          path: `/videos/${NONEXISTENT_UUID}/complete-upload`,
          body: { parts: [] },
        },
        {
          method: 'post' as const,
          path: `/videos/${NONEXISTENT_UUID}/abort-upload`,
          body: {},
        },
      ];

      for (const { method, path, body } of endpoints) {
        const res = await request(app.getHttpServer())[method](path).send(body);
        expect(res.status).toBe(401);
      }
    });

    it('allows public access to stream and download', async () => {
      const streamRes = await request(app.getHttpServer()).get(
        '/videos/does-not-exist/stream',
      );
      expect(streamRes.status).toBe(404);

      const downloadRes = await request(app.getHttpServer()).get(
        '/videos/does-not-exist/download',
      );
      expect(downloadRes.status).toBe(404);
    });
  });
});
