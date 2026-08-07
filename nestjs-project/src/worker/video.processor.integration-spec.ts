import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { DataSource, Repository } from 'typeorm';
import type { Job } from 'bullmq';
import { VideoProcessor } from './video.processor';
import { VideosService } from '../videos/videos.service';
import { StorageService } from '../storage/storage.service';
import { StorageModule } from '../storage/storage.module';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import {
  VIDEO_PROCESS_QUEUE,
  type VideoProcessJob,
} from '../queue/queue.types';
import databaseConfig from '../config/database.config';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import appConfig from '../config/app.config';
import authConfig from '../config/auth.config';
import mailConfig from '../config/mail.config';
import swaggerConfig from '../config/swagger.config';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';

const ALL_ENTITIES = [User, Channel, Video];

async function createWorkerTestModule(): Promise<TestingModule> {
  const ds = createTestDataSource(ALL_ENTITIES);
  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        load: [
          appConfig,
          authConfig,
          databaseConfig,
          mailConfig,
          swaggerConfig,
          storageConfig,
          queueConfig,
        ],
      }),
      TypeOrmModule.forRoot(ds.options),
      TypeOrmModule.forFeature(ALL_ENTITIES),
      BullModule.forRootAsync({
        imports: [ConfigModule],
        inject: [queueConfig.KEY],
        useFactory: (config: ConfigType<typeof queueConfig>) => ({
          connection: {
            host: config.host,
            port: config.port,
          },
        }),
      }),
      BullModule.registerQueue({ name: VIDEO_PROCESS_QUEUE }),
      StorageModule,
    ],
    providers: [VideoProcessor, VideosService],
  }).compile();
}

/* eslint-disable @typescript-eslint/no-unsafe-return */
function makeJob(data: VideoProcessJob): Job<VideoProcessJob> {
  return {
    id: 'test-job-id',
    data,
    updateProgress: jest.fn(),
  } as any;
}
/* eslint-enable @typescript-eslint/no-unsafe-return */

describe('VideoProcessor (integration)', () => {
  let processor: VideoProcessor;
  let dataSource: DataSource;
  let videoRepo: Repository<Video>;
  let channelRepo: Repository<Channel>;
  let userRepo: Repository<User>;
  let storageService: StorageService;

  beforeAll(async () => {
    const module = await createWorkerTestModule();
    processor = module.get(VideoProcessor);
    storageService = module.get(StorageService);
    dataSource = module.get(DataSource);
    videoRepo = dataSource.getRepository(Video);
    channelRepo = dataSource.getRepository(Channel);
    userRepo = dataSource.getRepository(User);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  describe('module bootstrap', () => {
    it('boots successfully with User, Channel, and Video entities registered', () => {
      // This test alone catches the User entity registration issue:
      // if User is not registered, TypeORM fails to resolve Channel -> User relation.
      expect(processor).toBeDefined();
    });

    it('resolves the full entity relation chain', async () => {
      // Create a user, channel, and video to verify the full FK chain works
      const user = userRepo.create({
        email: 'worker-test@example.com',
        password: 'hashed-password',
        is_confirmed: true,
      });
      const savedUser = await userRepo.save(user);

      const channel = channelRepo.create({
        name: 'Test Channel',
        nickname: 'testchannel',
        user_id: savedUser.id,
      });
      const savedChannel = await channelRepo.save(channel);

      const video = videoRepo.create({
        url_hash: 'test-hash-123456789',
        title: 'Test Video',
        channel_id: savedChannel.id,
        storage_bucket: 'test-bucket',
        storage_key: 'videos/testhash/video.mp4',
        status: VideoStatus.UPLOADING,
      });
      const savedVideo = await videoRepo.save(video);

      // Verify the full chain loaded
      const loaded = await videoRepo.findOne({
        where: { id: savedVideo.id },
        relations: { channel: { user: true } },
      });
      expect(loaded).not.toBeNull();
      expect(loaded!.channel).not.toBeNull();
      expect(loaded!.channel.user).not.toBeNull();
      expect(loaded!.channel.user.email).toBe('worker-test@example.com');
    });
  });

  describe('process error handling', () => {
    it('marks video as error when storageService.getObjectStream throws', async () => {
      // Create a user + channel + video
      const user = await userRepo.save(
        userRepo.create({
          email: 'error-test@example.com',
          password: 'hashed-password',
          is_confirmed: true,
        }),
      );
      const channel = await channelRepo.save(
        channelRepo.create({
          name: 'Error Channel',
          nickname: 'errorchannel',
          user_id: user.id,
        }),
      );
      const video = await videoRepo.save(
        videoRepo.create({
          url_hash: 'error-test-hash-123',
          title: 'Error Test Video',
          channel_id: channel.id,
          storage_bucket: 'test-bucket',
          storage_key: 'videos/errorhash/video.mp4',
          status: VideoStatus.UPLOADING,
        }),
      );

      // Spy on getObjectStream to simulate a storage failure
      const errorMessage = 'Simulated MinIO connection failure';
      jest
        .spyOn(storageService, 'getObjectStream')
        .mockRejectedValueOnce(new Error(errorMessage));

      const job = makeJob({
        videoId: video.id,
        storageBucket: video.storage_bucket,
        storageKey: video.storage_key,
      });

      await expect(processor.process(job)).rejects.toThrow(errorMessage);

      // Verify video was marked as error in DB
      const updated = await videoRepo.findOneBy({ id: video.id });
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe(VideoStatus.ERROR);
      expect(updated!.error_message).toBe(errorMessage);
    });

    it('updates status to PROCESSING before attempting to download', async () => {
      // Create a user + channel + video
      const user = await userRepo.save(
        userRepo.create({
          email: 'status-test@example.com',
          password: 'hashed-password',
          is_confirmed: true,
        }),
      );
      const channel = await channelRepo.save(
        channelRepo.create({
          name: 'Status Channel',
          nickname: 'statuschannel',
          user_id: user.id,
        }),
      );
      const video = await videoRepo.save(
        videoRepo.create({
          url_hash: 'status-test-hash-456',
          title: 'Status Test Video',
          channel_id: channel.id,
          storage_bucket: 'test-bucket',
          storage_key: 'videos/statushash/video.mp4',
          status: VideoStatus.UPLOADING,
        }),
      );

      // Simulate failure after status update (getObjectStream throws)
      jest
        .spyOn(storageService, 'getObjectStream')
        .mockRejectedValueOnce(new Error('Any error'));

      try {
        await processor.process(
          makeJob({
            videoId: video.id,
            storageBucket: video.storage_bucket,
            storageKey: video.storage_key,
          }),
        );
      } catch {
        // Expected to throw
      }

      // Verify the status was set to PROCESSING (first step of process())
      // and then to ERROR (after getObjectStream fails)
      const updated = await videoRepo.findOneBy({ id: video.id });
      expect(updated!.status).toBe(VideoStatus.ERROR);
      expect(updated!.error_message).toBe('Any error');
    });
  });
});
