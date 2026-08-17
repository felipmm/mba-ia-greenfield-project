import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { VideosService } from './videos.service';
import { Video, VideoStatus } from './entities/video.entity';

describe('VideosService', () => {
  let service: VideosService;

  const mockRepository = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideosService,
        {
          provide: getRepositoryToken(Video),
          useValue: mockRepository,
        },
      ],
    }).compile();

    service = module.get<VideosService>(VideosService);
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('should create a video with draft status', async () => {
      const videoData = {
        urlHash: 'abc123',
        channelId: 'channel-uuid',
        storageBucket: 'bucket',
        storageKey: 'videos/abc123/video.mp4',
        fileName: 'test.mp4',
        uploadId: 'upload-id',
      };

      const created = { ...videoData, id: 'uuid', status: VideoStatus.DRAFT };
      mockRepository.create.mockReturnValue(created);
      mockRepository.save.mockResolvedValue(created);

      const result = await service.create(videoData);

      expect(mockRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          url_hash: 'abc123',
          channel_id: 'channel-uuid',
          status: VideoStatus.DRAFT,
        }),
      );
      expect(result.status).toBe(VideoStatus.DRAFT);
    });
  });

  describe('findById', () => {
    it('should return a video with channel relation', async () => {
      const video = { id: 'uuid', url_hash: 'abc', channel: { user_id: 'u1' } };
      mockRepository.findOne.mockResolvedValue(video);

      const result = await service.findById('uuid');
      expect(result).toEqual(video);
      expect(mockRepository.findOne).toHaveBeenCalledWith({
        where: { id: 'uuid' },
        relations: ['channel'],
      });
    });

    it('should throw NotFoundException when video not found', async () => {
      mockRepository.findOne.mockResolvedValue(null);
      await expect(service.findById('uuid')).rejects.toThrow(NotFoundException);
    });
  });

  describe('findByUrlHash', () => {
    it('should return video by url_hash', async () => {
      const video = { id: 'uuid', url_hash: 'abc' };
      mockRepository.findOne.mockResolvedValue(video);

      const result = await service.findByUrlHash('abc');
      expect(result).toEqual(video);
    });

    it('should return null when not found', async () => {
      mockRepository.findOne.mockResolvedValue(null);
      const result = await service.findByUrlHash('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('findByUrlHashOrFail', () => {
    it('should throw NotFoundException when not found', async () => {
      mockRepository.findOne.mockResolvedValue(null);
      await expect(service.findByUrlHashOrFail('nonexistent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('updateStatus', () => {
    it('should update video status', async () => {
      await service.updateStatus('uuid', VideoStatus.PROCESSING);
      expect(mockRepository.update).toHaveBeenCalledWith('uuid', {
        status: VideoStatus.PROCESSING,
        error_message: null,
      });
    });

    it('should set error_message when provided', async () => {
      await service.updateStatus('uuid', VideoStatus.ERROR, 'FFmpeg crashed');
      expect(mockRepository.update).toHaveBeenCalledWith('uuid', {
        status: VideoStatus.ERROR,
        error_message: 'FFmpeg crashed',
      });
    });
  });

  describe('markAsProcessing', () => {
    it('should set status to processing', async () => {
      await service.markAsProcessing('uuid');
      expect(mockRepository.update).toHaveBeenCalledWith('uuid', {
        status: VideoStatus.PROCESSING,
      });
    });
  });

  describe('markAsReady', () => {
    it('should set status to ready with metadata', async () => {
      const metadata = {
        durationSeconds: 120,
        width: 1920,
        height: 1080,
        codec: 'h264',
        bitrateBps: 5000000,
        fileSizeBytes: 1000000,
        thumbnailStorageKey: 'thumbs/abc.png',
      };

      await service.markAsReady('uuid', metadata);

      expect(mockRepository.update).toHaveBeenCalledWith('uuid', {
        status: VideoStatus.READY,
        duration_seconds: 120,
        width: 1920,
        height: 1080,
        codec: 'h264',
        bitrate_bps: 5000000,
        file_size_bytes: 1000000,
        thumbnail_storage_key: 'thumbs/abc.png',
      });
    });
  });

  describe('markAsError', () => {
    it('should set status to error with message', async () => {
      await service.markAsError('uuid', 'Processing failed');
      expect(mockRepository.update).toHaveBeenCalledWith('uuid', {
        status: VideoStatus.ERROR,
        error_message: 'Processing failed',
      });
    });
  });

  describe('remove', () => {
    it('should delete video by id', async () => {
      await service.remove('uuid');
      expect(mockRepository.delete).toHaveBeenCalledWith('uuid');
    });
  });
});
