import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { VIDEO_PROCESS_QUEUE, type VideoProcessJob } from './queue.types';

@Injectable()
export class QueueService {
  constructor(
    @InjectQueue(VIDEO_PROCESS_QUEUE)
    private readonly videoQueue: Queue<VideoProcessJob>,
  ) {}

  async addProcessVideoJob(data: VideoProcessJob): Promise<string> {
    const job = await this.videoQueue.add('video.process', data, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 10,
      removeOnFail: 20,
    });
    return job.id!;
  }
}
