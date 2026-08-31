export type VideoKind = 'video' | 'short' | 'live';
export type FetchBackend = 'native' | 'invidious' | 'rss' | 'lbry' | 'bili' | 'peertube' | 'soundcloud';
export type SourceKind = 'youtube' | 'odysee' | 'bilibili' | 'peertube' | 'soundcloud';

export interface ChannelRecord {
  id: string;
  source: SourceKind;
  name: string;
  avatarUrl: string | null;
  tags: string[];
  addedAt: number;
  lastFetchedAt: number | null;
  lastVideosFetchedAt: number | null;
  lastShortsFetchedAt: number | null;
  lastLiveFetchedAt: number | null;
  lastError: string | null;
  urlSlug?: string | null;
}

export interface TagDefinition {
  name: string;
  color: string;
  refreshIntervalMin: number;
}

export interface VideoRecord {
  id: string;
  source: SourceKind;
  channelId: string;
  title: string;
  publishedAt: number | null;
  approxDate: boolean;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
  viewCount: number | null;
  kind: VideoKind;
  seen: boolean;
  seenAt: number | null;
  backend: FetchBackend;
  fetchedAt: number;
}

export interface ParsedVideo {
  id: string;
  title: string;
  publishedAt: number | null;
  approxDate: boolean;
  durationSeconds: number | null;
  viewCount: number | null;
  kind: VideoKind;
  thumbnailUrl: string | null;
}

export type EngineTab = 'videos' | 'shorts' | 'live';

export interface EngineStatus {
  running: boolean;
  done: number;
  total: number;
  currentChannel: string | null;
  errors: string[];
  startedAt: number | null;
  finishedAt: number | null;
  addedVideos: number;
  perSource?: { processed: Record<string, number>; added: Record<string, number>; errors: Record<string, number> };
}

export interface EngineLogEntry {
  ts: number;
  level: 'info' | 'warn' | 'error';
  channelId: string | null;
  channelName: string | null;
  /** Platform this log entry is about. Null for engine-wide events. */
  source: SourceKind | null;
  message: string;
}

export interface ImportedChannel {
  id: string | null;
  url: string | null;
  name: string | null;
  avatarUrl?: string | null;
  tags?: string[];
  source?: SourceKind;
}

export interface ImportSummary {
  detected: string;
  parsed: number;
  added: number;
  duplicates: number;
  failed: { input: string; error: string }[];
}
