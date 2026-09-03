import type { ChannelRecord, SourceKind, TagDefinition, VideoRecord } from './types';
import * as api from './api-client';

export function videoStorageKey(source: SourceKind, id: string): string {
  return `${source}:${id}`;
}

export { listChannels, getChannel } from './api-client';

export async function upsertChannels(channels: ChannelRecord[]): Promise<void> {
  return api.upsertChannels(channels);
}

export async function patchChannel(
  id: string,
  patch: Partial<Omit<ChannelRecord, 'id' | 'addedAt'>>,
): Promise<void> {
  return api.patchChannel(id, patch);
}

export async function deleteChannelCascade(id: string): Promise<void> {
  return api.deleteChannelCascade(id);
}

export interface NewVideo {
  id: string;
  source: SourceKind;
  channelId: string;
  title: string;
  publishedAt: number | null;
  approxDate: boolean;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
  viewCount: number | null;
  kind: VideoRecord['kind'];
  backend: VideoRecord['backend'];
  fetchedAt: number;
}

export async function mergeVideos(incoming: NewVideo[]): Promise<number> {
  return api.mergeVideos(incoming);
}

export async function listVideos(): Promise<VideoRecord[]> {
  return api.listVideos();
}

export async function countUnread(): Promise<number> {
  return api.countUnread();
}

export async function setSeen(videoIds: string[], seen: boolean): Promise<void> {
  return api.setSeen(videoIds, seen);
}

export async function markAllSeen(): Promise<void> {
  return api.markAllSeen();
}

export async function clearVideos(): Promise<void> {
  return api.clearVideos();
}

export async function pruneOldVideos(maxAgeDays: number): Promise<void> {
  return api.pruneOldVideos(maxAgeDays);
}

export async function listTags(): Promise<TagDefinition[]> {
  return api.listTags();
}

export async function upsertTag(tag: TagDefinition): Promise<void> {
  return api.upsertTag(tag);
}

export async function deleteTag(name: string): Promise<void> {
  return api.deleteTag(name);
}

export async function renameTag(oldName: string, newName: string): Promise<void> {
  return api.renameTag(oldName, newName);
}

export async function listUntaggedChannels(): Promise<ChannelRecord[]> {
  return api.listUntaggedChannels();
}

export async function setChannelTags(channelId: string, tags: string[]): Promise<void> {
  return api.setChannelTags(channelId, tags);
}

export async function markHistoryAsSeen(
  entries: { videoId: string; source: SourceKind; watchedAt: number }[],
): Promise<{ matched: number; total: number }> {
  return api.markHistoryAsSeen(entries);
}

export async function listSeenVideos(): Promise<VideoRecord[]> {
  return api.listSeenVideos();
}

export async function countSeenVideos(): Promise<number> {
  return api.countSeenVideos();
}

export async function clearHistory(): Promise<void> {
  return api.clearHistory();
}
