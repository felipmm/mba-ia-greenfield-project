import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { QueueService } from './queue.service';
import { VIDEO_PROCESS_QUEUE, type VideoProcessJob } from './queue.types';
import queueConfig from '../config/queue.config';

function getQueue(module: TestingModule): Queue<VideoProcessJob> {
  return module.get<Queue<VideoProcessJob>>(getQueueToken(VIDEO_PROCESS_QUEUE));
}

describe('QueueService (integration)', () => {
  let service: QueueService;
  let module: TestingModule;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [queueConfig],
        }),
        BullModule.forRootAsync({
          imports: [ConfigModule],
          inject: [queueConfig.KEY],
          useFactory: (config: ReturnType<typeof queueConfig>) => ({
            connection: {
              host: config.host,
              port: config.port,
            },
          }),
        }),
        BullModule.registerQueue({ name: VIDEO_PROCESS_QUEUE }),
      ],
      providers: [QueueService],
    }).compile();

    service = module.get(QueueService);
  });

  afterAll(async () => {
    // Drain and clean the queue before closing
    try {
      const queue = getQueue(module);
      await queue.obliterate({ force: true });
      await queue.close();
    } catch {
      // queue may already be closed
    }
    await module.close();
  });

  beforeEach(async () => {
    // Clean the queue between tests
    const queue = getQueue(module);
    await queue.drain();
  });

  describe('addProcessVideoJob', () => {
    it('enqueues a job and returns a job ID', async () => {
      const jobData: VideoProcessJob = {
        videoId: '00000000-0000-0000-0000-000000000001',
        storageBucket: 'test-bucket',
        storageKey: 'videos/test123/video.mp4',
      };

      const jobId = await service.addProcessVideoJob(jobData);
      expect(jobId).toBeDefined();
      expect(typeof jobId).toBe('string');
    });

    it('stores the correct job data in the queue', async () => {
      const jobData: VideoProcessJob = {
        videoId: '00000000-0000-0000-0000-000000000002',
        storageBucket: 'test-bucket',
        storageKey: 'videos/test456/video.mp4',
      };

      const jobId = await service.addProcessVideoJob(jobData);

      const queue = getQueue(module);
      const job = await queue.getJob(jobId);
      expect(job).not.toBeNull();
      expect(job!.data).toEqual(jobData);
      expect(job!.name).toBe('video.process');
    });

    it('configures retry attempts and backoff on enqueued jobs', async () => {
      const jobData: VideoProcessJob = {
        videoId: '00000000-0000-0000-0000-000000000003',
        storageBucket: 'test-bucket',
        storageKey: 'videos/test789/video.mp4',
      };

      const jobId = await service.addProcessVideoJob(jobData);

      const queue = getQueue(module);
      const job = await queue.getJob(jobId);
      expect(job).not.toBeNull();
      expect(job!.opts.attempts).toBe(3);
      expect(job!.opts.backoff).toEqual({
        type: 'exponential',
        delay: 5000,
      });
    });
  });
});
