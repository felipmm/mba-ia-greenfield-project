import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { StorageService } from './storage.service';
import { StorageModule } from './storage.module';
import storageConfig from '../config/storage.config';
import * as crypto from 'crypto';

function createS3Client() {
  const cfg = storageConfig();
  return new S3Client({
    endpoint: `http://${cfg.endpoint}:${cfg.port}`,
    region: cfg.region,
    credentials: {
      accessKeyId: cfg.accessKey,
      secretAccessKey: cfg.secretKey,
    },
    forcePathStyle: true,
  });
}

async function putObject(
  bucket: string,
  key: string,
  body: string,
): Promise<void> {
  const client = createS3Client();
  await client.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }),
  );
}

async function listTestObjects(bucket: string): Promise<string[]> {
  const client = createS3Client();
  try {
    const response = await client.send(
      new ListObjectsV2Command({ Bucket: bucket }),
    );
    return (response.Contents ?? []).map((o) => o.Key!);
  } catch {
    return [];
  }
}

async function deleteObject(bucket: string, key: string): Promise<void> {
  const client = createS3Client();
  try {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } catch {
    // object may not exist
  }
}

describe('StorageService (integration)', () => {
  let service: StorageService;
  const testBucket = `test-bucket-${crypto.randomBytes(4).toString('hex')}`;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig],
        }),
        StorageModule,
      ],
    }).compile();

    service = module.get(StorageService);
  });

  afterAll(async () => {
    try {
      const objects = await listTestObjects(testBucket);
      for (const key of objects) {
        await deleteObject(testBucket, key);
      }
    } catch {
      // bucket may not exist, ignore
    }
  });

  describe('ensureBucket', () => {
    it('creates a bucket that does not exist', async () => {
      await service.ensureBucket(testBucket);
      // Second call with same bucket should not throw
      await service.ensureBucket(testBucket);
    });
  });

  describe('multipart upload lifecycle', () => {
    it('creates and aborts a multipart upload', async () => {
      await service.ensureBucket(testBucket);

      const key = `test/multipart-${crypto.randomBytes(4).toString('hex')}.txt`;
      const uploadId = await service.createMultipartUpload(
        testBucket,
        key,
        'text/plain',
      );
      expect(uploadId).toBeDefined();
      expect(typeof uploadId).toBe('string');

      // Generate presigned URLs
      const urls = await service.generatePresignedPartUrls(
        testBucket,
        key,
        uploadId,
        1,
      );
      expect(urls).toHaveLength(1);
      expect(urls[0].partNumber).toBe(1);
      expect(urls[0].url).toContain('uploadId=');

      // Abort should not throw
      await service.abortMultipartUpload(testBucket, key, uploadId);
    });
  });

  describe('getObjectStream', () => {
    it('retrieves an object that was stored', async () => {
      await service.ensureBucket(testBucket);

      const key = `test/object-${crypto.randomBytes(4).toString('hex')}.txt`;
      const content = 'Hello, MinIO!';
      await putObject(testBucket, key, content);

      const { stream, contentType, contentLength } =
        await service.getObjectStream(testBucket, key);
      expect(contentType).toBe('application/octet-stream');
      expect(contentLength).toBe(content.length);
      expect(stream).toBeDefined();
    });
  });

  describe('presigned download URL', () => {
    it('generates a presigned URL for an existing object', async () => {
      await service.ensureBucket(testBucket);

      const key = `test/download-${crypto.randomBytes(4).toString('hex')}.txt`;
      await putObject(testBucket, key, 'download test content');

      const url = await service.generatePresignedDownloadUrl(
        testBucket,
        key,
        3600,
      );
      expect(url).toContain(testBucket);
      expect(url).toContain(key);
      expect(url).toContain('X-Amz-Signature');
    });
  });
});
