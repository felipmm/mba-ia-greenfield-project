export interface VideoProcessJob {
  videoId: string;
  storageBucket: string;
  storageKey: string;
}

export const VIDEO_PROCESS_QUEUE = 'video';
