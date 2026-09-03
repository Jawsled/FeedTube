import type { HistoryEntry } from './import-history';
import type { VideoRecord } from '../types';

export interface FeedTubeHistoryExport {
  app: 'FeedTube';
  type: 'history';
  version: 1;
  exportedAt: string;
  history: HistoryEntry[];
}

export function buildHistoryExport(videos: VideoRecord[]): FeedTubeHistoryExport {
  const history: HistoryEntry[] = videos
    .filter((v) => v.seen && v.seenAt)
    .map((v) => ({
      videoId: v.id.replace(/^[^:]+:/, ''),
      source: v.source,
      title: v.title,
      channelName: null,
      channelId: v.channelId,
      watchedAt: v.seenAt!,
      durationSeconds: v.durationSeconds,
    }));

  return {
    app: 'FeedTube',
    type: 'history',
    version: 1,
    exportedAt: new Date().toISOString(),
    history,
  };
}
