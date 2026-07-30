import { DataSource } from 'typeorm';
import { Video, VideoStatus } from './video.entity';
import { Channel } from '../../channels/entities/channel.entity';
import { User } from '../../users/entities/user.entity';
import { createTestDataSource } from '../../test/create-test-data-source';

describe('Video entity (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource([User, Channel, Video]);
    await dataSource.initialize();
    await dataSource.synchronize(true);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await dataSource.query('DELETE FROM "channels"');
    await dataSource.query('DELETE FROM "users"');
  });

  async function createUserAndChannel(
    email: string,
    nickname: string,
  ): Promise<{ user: User; channel: Channel }> {
    const userRepo = dataSource.getRepository(User);
    const channelRepo = dataSource.getRepository(Channel);

    const user = await userRepo.save(
      userRepo.create({
        email,
        password: 'hashed',
        is_confirmed: true,
      }),
    );

    const channel = await channelRepo.save(
      channelRepo.create({
        name: nickname,
        nickname,
        user_id: user.id,
      }),
    );

    return { user, channel };
  }

  it('should default status to draft', async () => {
    const { channel } = await createUserAndChannel('a@test.com', 'channel_a');
    const videoRepo = dataSource.getRepository(Video);

    const video = await videoRepo.save(
      videoRepo.create({
        url_hash: 'test123',
        title: 'Test Video',
        storage_bucket: 'bucket',
        storage_key: 'videos/test123/file.mp4',
        channel_id: channel.id,
      }),
    );

    expect(video.status).toBe(VideoStatus.DRAFT);
    expect(video.url_hash).toBe('test123');
  });

  it('should enforce unique url_hash constraint', async () => {
    const { channel } = await createUserAndChannel('b@test.com', 'channel_b');
    const videoRepo = dataSource.getRepository(Video);

    await videoRepo.save(
      videoRepo.create({
        url_hash: 'duplicate',
        storage_bucket: 'bucket',
        storage_key: 'key1',
        channel_id: channel.id,
      }),
    );

    await expect(
      videoRepo.save(
        videoRepo.create({
          url_hash: 'duplicate',
          storage_bucket: 'bucket',
          storage_key: 'key2',
          channel_id: channel.id,
        }),
      ),
    ).rejects.toThrow();
  });

  it('should reject invalid status values', async () => {
    const { channel } = await createUserAndChannel('c@test.com', 'channel_c');
    const videoRepo = dataSource.getRepository(Video);

    await expect(
      videoRepo.save(
        videoRepo.create({
          url_hash: 'status-test',
          storage_bucket: 'bucket',
          storage_key: 'key',
          channel_id: channel.id,
          status: 'invalid_status' as VideoStatus,
        }),
      ),
    ).rejects.toThrow();
  });

  it('should store nullable metadata fields', async () => {
    const { channel } = await createUserAndChannel('d@test.com', 'channel_d');
    const videoRepo = dataSource.getRepository(Video);

    const video = await videoRepo.save(
      videoRepo.create({
        url_hash: 'metadata-test',
        storage_bucket: 'bucket',
        storage_key: 'key',
        channel_id: channel.id,
        status: VideoStatus.READY,
        duration_seconds: 180.5,
        width: 1280,
        height: 720,
        codec: 'h264',
        bitrate_bps: 2500000,
        file_size_bytes: 50000000,
        thumbnail_storage_key: 'thumbs/thumbnail.png',
        upload_id: 's3-upload-id',
      }),
    );

    const found = await videoRepo.findOneBy({ id: video.id });
    expect(found?.duration_seconds).toBe(180.5);
    expect(found?.width).toBe(1280);
    expect(found?.height).toBe(720);
    expect(found?.codec).toBe('h264');
    expect(found?.bitrate_bps).toBe(2500000);
    expect(found?.file_size_bytes).toBe('50000000');
    expect(found?.thumbnail_storage_key).toBe('thumbs/thumbnail.png');
  });

  it('should transition through status lifecycle', async () => {
    const { channel } = await createUserAndChannel('e@test.com', 'channel_e');
    const videoRepo = dataSource.getRepository(Video);

    const video = await videoRepo.save(
      videoRepo.create({
        url_hash: 'lifecycle',
        storage_bucket: 'bucket',
        storage_key: 'key',
        channel_id: channel.id,
      }),
    );
    expect(video.status).toBe(VideoStatus.DRAFT);

    video.status = VideoStatus.UPLOADING;
    const uploading = await videoRepo.save(video);
    expect(uploading.status).toBe(VideoStatus.UPLOADING);

    video.status = VideoStatus.PROCESSING;
    const processing = await videoRepo.save(video);
    expect(processing.status).toBe(VideoStatus.PROCESSING);

    video.status = VideoStatus.READY;
    const ready = await videoRepo.save(video);
    expect(ready.status).toBe(VideoStatus.READY);

    video.status = VideoStatus.ERROR;
    video.error_message = 'Something went wrong';
    const error = await videoRepo.save(video);
    expect(error.status).toBe(VideoStatus.ERROR);
    expect(error.error_message).toBe('Something went wrong');
  });

  it('should create and update timestamps automatically', async () => {
    const { channel } = await createUserAndChannel('f@test.com', 'channel_f');
    const videoRepo = dataSource.getRepository(Video);

    const video = await videoRepo.save(
      videoRepo.create({
        url_hash: 'timestamps',
        storage_bucket: 'bucket',
        storage_key: 'key',
        channel_id: channel.id,
      }),
    );

    expect(video.created_at).toBeInstanceOf(Date);
    expect(video.updated_at).toBeInstanceOf(Date);
  });
});
