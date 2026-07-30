import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Injectable } from '@nestjs/common';
import { VideosService } from '../videos/videos.service';
import { StorageService } from '../storage/storage.service';
import type { VideoProcessJob } from '../queue/queue.types';
import { VIDEO_PROCESS_QUEUE } from '../queue/queue.types';
import { VideoStatus } from '../videos/entities/video.entity';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import storageCfg from '../config/storage.config';
import { Upload } from '@aws-sdk/lib-storage';
import { S3Client } from '@aws-sdk/client-s3';

interface ProbeResult {
  durationSeconds: number;
  width: number;
  height: number;
  codec: string;
  bitrateBps: number;
}

type FfmpegModule = any;

@Processor(VIDEO_PROCESS_QUEUE)
@Injectable()
export class VideoProcessor extends WorkerHost {
  private readonly ffmpeg: FfmpegModule;

  constructor(
    private readonly videosService: VideosService,
    private readonly storageService: StorageService,
  ) {
    super();
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
    this.ffmpeg = require('fluent-ffmpeg');
  }

  async process(job: Job<VideoProcessJob>): Promise<void> {
    const { videoId, storageBucket, storageKey } = job.data;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-process-'));
    const videoPath = path.join(tempDir, 'video.mp4');
    const thumbnailPath = path.join(tempDir, 'thumbnail.png');

    try {
      await this.videosService.updateStatus(videoId, VideoStatus.PROCESSING);

      // Download video from MinIO to temp file
      const { stream } = await this.storageService.getObjectStream(
        storageBucket,
        storageKey,
      );
      await this.writeStreamToFile(stream, videoPath);

      // Extract metadata via ffprobe
      const metadata = await this.probeVideo(videoPath);

      // Generate thumbnail at 10% of duration (or 5 seconds, whichever is smaller)
      const thumbTime = Math.min(metadata.durationSeconds * 0.1, 5);
      await this.generateThumbnail(videoPath, thumbnailPath, thumbTime);

      // Upload thumbnail to MinIO
      const urlHash = storageKey.split('/')[1];
      const thumbnailKey = `videos/${urlHash}/thumbnail.png`;
      await this.uploadThumbnail(storageBucket, thumbnailKey, thumbnailPath);

      // Update video in DB with metadata
      const fileStats = fs.statSync(videoPath);
      await this.videosService.markAsReady(videoId, {
        durationSeconds: metadata.durationSeconds,
        width: metadata.width,
        height: metadata.height,
        codec: metadata.codec,
        bitrateBps: metadata.bitrateBps,
        fileSizeBytes: fileStats.size,
        thumbnailStorageKey: thumbnailKey,
      });

      await job.updateProgress(100);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown processing error';
      await this.videosService.markAsError(videoId, message);
      throw error;
    } finally {
      // Clean up temp files
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
  private probeVideo(filePath: string): Promise<ProbeResult> {
    return new Promise((resolve, reject) => {
      this.ffmpeg.ffprobe(filePath, (err: Error | null, metadata: any) => {
        if (err) {
          reject(err);
          return;
        }
        const videoStream = metadata.streams.find(
          (s: any) => s.codec_type === 'video',
        );
        if (!videoStream) {
          reject(new Error('No video stream found'));
          return;
        }
        const bitrate = metadata.format.bit_rate
          ? Number(metadata.format.bit_rate)
          : 0;
        resolve({
          durationSeconds: Number(metadata.format.duration ?? 0),
          width: Number(videoStream.width ?? 0),
          height: Number(videoStream.height ?? 0),
          codec: String(videoStream.codec_name ?? 'unknown'),
          bitrateBps: bitrate,
        });
      });
    });
  }

  private generateThumbnail(
    videoPath: string,
    outputPath: string,
    timestamp: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ffmpeg(videoPath)
        .screenshots({
          timestamps: [timestamp],
          filename: path.basename(outputPath),
          folder: path.dirname(outputPath),
          size: '1280x720',
        })
        .on('end', () => resolve())
        .on('error', (err: Error) => reject(err));
    });
  }
  /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */

  private async uploadThumbnail(
    bucket: string,
    key: string,
    filePath: string,
  ): Promise<void> {
    const config = storageCfg();

    const client = new S3Client({
      endpoint: `http://${config.endpoint}:${config.port}`,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
      forcePathStyle: true,
    });

    const fileStream = fs.createReadStream(filePath);
    const upload = new Upload({
      client,
      params: {
        Bucket: bucket,
        Key: key,
        Body: fileStream,
        ContentType: 'image/png',
      },
    });

    await upload.done();
  }

  private writeStreamToFile(
    stream: NodeJS.ReadableStream,
    filePath: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const writeStream = fs.createWriteStream(filePath);
      stream.pipe(writeStream);
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
      stream.on('error', reject);
    });
  }
}
