import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
  StreamableFile,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { VideosService } from './videos.service';
import { StorageService } from '../storage/storage.service';
import { QueueService } from '../queue/queue.service';
import { ChannelsService } from '../channels/channels.service';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { Public } from '../auth/decorators/public.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/auth.types';
import { VideoStatus } from './entities/video.entity';
import { generateUrlHash } from '../common/url-hash.util';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { Inject } from '@nestjs/common';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import type { CompletedPart } from '@aws-sdk/client-s3';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(
    private readonly videosService: VideosService,
    private readonly storageService: StorageService,
    private readonly queueService: QueueService,
    private readonly channelsService: ChannelsService,
    @Inject(storageConfig.KEY)
    private readonly storageCfg: ConfigType<typeof storageConfig>,
  ) {}

  @Post('initiate-upload')
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Initiate a video upload',
    description:
      'Creates a video in draft status and returns presigned URLs for direct MinIO multipart upload.',
  })
  @ApiResponse({
    status: 201,
    description: 'Upload initiated successfully',
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async initiateUpload(
    @Body() dto: InitiateUploadDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const channel = await this.channelsService.findByUserIdOrFail(user.sub);
    const urlHash = generateUrlHash();
    const storageKey = `videos/${urlHash}/${dto.fileName}`;
    const bucket = this.storageCfg.bucket;

    const uploadId = await this.storageService.createMultipartUpload(
      bucket,
      storageKey,
      dto.mimeType,
    );

    const video = await this.videosService.create({
      urlHash,
      channelId: channel.id,
      storageBucket: bucket,
      storageKey,
      fileName: dto.fileName,
      uploadId,
    });

    const presignedUrls = await this.storageService.generatePresignedPartUrls(
      bucket,
      storageKey,
      uploadId,
      dto.partCount,
    );

    await this.videosService.updateStatus(video.id, VideoStatus.UPLOADING);

    const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();

    return {
      video: {
        id: video.id,
        urlHash: video.url_hash,
        status: VideoStatus.UPLOADING,
      },
      uploadId,
      presignedUrls,
      expiresAt,
    };
  }

  @Post(':id/complete-upload')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete a multipart upload',
    description:
      'Completes the MinIO multipart upload and enqueues the video for processing.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload completed, processing started',
  })
  @ApiResponse({
    status: 403,
    description: 'Not the video owner',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video not in uploading state',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @Param('id') id: string,
    @Body() dto: CompleteUploadDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const video = await this.videosService.findById(id);
    if (video.channel.user_id !== user.sub) {
      throw new ForbiddenException('Not the video owner');
    }

    if (video.status !== VideoStatus.UPLOADING) {
      throw new ConflictException(
        `Video is in status '${video.status}', expected 'uploading'`,
      );
    }

    const parts: CompletedPart[] = dto.parts.map((p) => ({
      PartNumber: p.partNumber,
      ETag: p.etag,
    }));

    await this.storageService.completeMultipartUpload(
      video.storage_bucket,
      video.storage_key,
      video.upload_id!,
      parts,
    );

    await this.videosService.markAsProcessing(id);

    await this.queueService.addProcessVideoJob({
      videoId: video.id,
      storageBucket: video.storage_bucket,
      storageKey: video.storage_key,
    });

    return {
      video: {
        id: video.id,
        urlHash: video.url_hash,
        status: VideoStatus.PROCESSING,
      },
    };
  }

  @Post(':id/abort-upload')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Abort a multipart upload',
    description:
      'Aborts the MinIO multipart upload and deletes the draft video.',
  })
  @ApiResponse({
    status: 204,
    description: 'Upload aborted',
  })
  @ApiResponse({
    status: 403,
    description: 'Not the video owner',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async abortUpload(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    const video = await this.videosService.findById(id);
    if (video.channel.user_id !== user.sub) {
      throw new ForbiddenException('Not the video owner');
    }

    if (video.upload_id) {
      await this.storageService.abortMultipartUpload(
        video.storage_bucket,
        video.storage_key,
        video.upload_id,
      );
    }

    await this.videosService.remove(id);
  }

  @Public()
  @Get(':urlHash/stream')
  @ApiOperation({
    summary: 'Stream a video',
    description:
      'Streams a video with HTTP Range support (206 Partial Content).',
  })
  @ApiResponse({
    status: 206,
    description: 'Partial content (range request)',
  })
  @ApiResponse({
    status: 200,
    description: 'Full content (no range header)',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async stream(
    @Param('urlHash') urlHash: string,
    @Headers('range') range: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const video = await this.videosService.findByUrlHashOrFail(urlHash);

    const { stream, contentType, contentLength, contentRange } =
      await this.storageService.getObjectStream(
        video.storage_bucket,
        video.storage_key,
        range,
      );

    res.set({
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Content-Length': contentLength.toString(),
    });

    if (contentRange) {
      res.status(206);
      res.set('Content-Range', contentRange);
    }

    return new StreamableFile(stream);
  }

  @Public()
  @Get(':urlHash/download')
  @ApiOperation({
    summary: 'Download a video',
    description:
      'Downloads the complete video file with Content-Disposition header.',
  })
  @ApiResponse({
    status: 200,
    description: 'Video download',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async download(
    @Param('urlHash') urlHash: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const video = await this.videosService.findByUrlHashOrFail(urlHash);

    const presignedUrl = await this.storageService.generatePresignedDownloadUrl(
      video.storage_bucket,
      video.storage_key,
    );

    // Extract filename from storage key
    const fileName = video.storage_key.split('/').pop() ?? 'video.mp4';

    res.set({
      'Content-Disposition': `attachment; filename="${fileName}"`,
    });

    res.redirect(presignedUrl);
  }
}
