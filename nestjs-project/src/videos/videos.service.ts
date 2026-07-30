import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Video, VideoStatus } from './entities/video.entity';

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
  ) {}

  async create(data: {
    urlHash: string;
    channelId: string;
    storageBucket: string;
    storageKey: string;
    fileName: string;
    uploadId: string;
  }): Promise<Video> {
    const video = this.videoRepository.create({
      url_hash: data.urlHash,
      channel_id: data.channelId,
      storage_bucket: data.storageBucket,
      storage_key: data.storageKey,
      title: data.fileName,
      upload_id: data.uploadId,
      status: VideoStatus.DRAFT,
    });
    return this.videoRepository.save(video);
  }

  async findById(id: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { id },
      relations: ['channel'],
    });
    if (!video) {
      throw new NotFoundException('Video not found');
    }
    return video;
  }

  async findByUrlHash(urlHash: string): Promise<Video | null> {
    return this.videoRepository.findOne({
      where: { url_hash: urlHash },
    });
  }

  async findByUrlHashOrFail(urlHash: string): Promise<Video> {
    const video = await this.findByUrlHash(urlHash);
    if (!video) {
      throw new NotFoundException('Video not found');
    }
    return video;
  }

  async updateStatus(
    id: string,
    status: VideoStatus,
    errorMessage?: string,
  ): Promise<void> {
    await this.videoRepository.update(id, {
      status,
      error_message: errorMessage ?? null,
    });
  }

  async markAsProcessing(id: string): Promise<void> {
    await this.videoRepository.update(id, {
      status: VideoStatus.PROCESSING,
    });
  }

  async markAsReady(
    id: string,
    metadata: {
      durationSeconds: number;
      width: number;
      height: number;
      codec: string;
      bitrateBps: number;
      fileSizeBytes: number;
      thumbnailStorageKey: string;
    },
  ): Promise<void> {
    await this.videoRepository.update(id, {
      status: VideoStatus.READY,
      duration_seconds: metadata.durationSeconds,
      width: metadata.width,
      height: metadata.height,
      codec: metadata.codec,
      bitrate_bps: metadata.bitrateBps,
      file_size_bytes: metadata.fileSizeBytes,
      thumbnail_storage_key: metadata.thumbnailStorageKey,
    });
  }

  async markAsError(id: string, errorMessage: string): Promise<void> {
    await this.videoRepository.update(id, {
      status: VideoStatus.ERROR,
      error_message: errorMessage,
    });
  }

  async remove(id: string): Promise<void> {
    await this.videoRepository.delete(id);
  }
}
