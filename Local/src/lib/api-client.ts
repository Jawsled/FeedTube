const BASE = '/api';

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`POST ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

async function put<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`PUT ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

async function del<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`DELETE ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

async function patch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

// ── Channels ─────────────────────────────────────────────────────────────────

import type { ChannelRecord, TagDefinition, VideoRecord } from './types';

export async function listChannels(): Promise<ChannelRecord[]> {
  return get<ChannelRecord[]>('/channels');
}

export async function getChannel(id: string): Promise<ChannelRecord | undefined> {
  try {
    return await get<ChannelRecord>(`/channels/${encodeURIComponent(id)}`);
  } catch {
    return undefined;
  }
}

export async function upsertChannels(channels: ChannelRecord[]): Promise<void> {
  await post('/channels', channels);
}

export async function patchChannel(
  id: string,
  data: Partial<Omit<ChannelRecord, 'id' | 'addedAt'>>,
): Promise<void> {
  await patch(`/channels/${encodeURIComponent(id)}`, data);
}

export async function deleteChannelCascade(id: string): Promise<void> {
  await del(`/channels/${encodeURIComponent(id)}`);
}

export async function setChannelTags(channelId: string, tags: string[]): Promise<void> {
  await post(`/channels/${encodeURIComponent(channelId)}/tags`, { tags });
}

// ── Videos ───────────────────────────────────────────────────────────────────

import type { NewVideo } from './db';

export async function listVideos(): Promise<VideoRecord[]> {
  return get<VideoRecord[]>('/videos');
}

export async function mergeVideos(incoming: NewVideo[]): Promise<number> {
  const res = await post<{ added: number }>('/videos/merge', incoming);
  return res.added;
}

export async function setSeen(videoIds: string[], seen: boolean): Promise<void> {
  await post('/videos/seen', { videoIds, seen });
}

export async function markAllSeen(): Promise<void> {
  await post('/videos/mark-all-seen');
}

export async function clearVideos(): Promise<void> {
  await del('/videos');
}

export async function pruneOldVideos(maxAgeDays: number): Promise<void> {
  await post('/videos/prune', { maxAgeDays });
}

export async function markHistoryAsSeen(
  entries: { videoId: string; source: string; watchedAt: number }[],
): Promise<{ matched: number; total: number }> {
  return post('/videos/history-as-seen', entries);
}

export async function listSeenVideos(): Promise<VideoRecord[]> {
  const all = await listVideos();
  return all.filter((v) => v.seen);
}

export async function countSeenVideos(): Promise<number> {
  const all = await listVideos();
  return all.filter((v) => v.seen).length;
}

export async function countUnread(): Promise<number> {
  const all = await listVideos();
  return all.filter((v) => !v.seen).length;
}

export async function clearHistory(): Promise<void> {
  const videos = await listVideos();
  const seenIds = videos.filter((v) => v.seen).map((v) => v.id);
  if (seenIds.length > 0) await setSeen(seenIds, false);
}

// ── Tags ─────────────────────────────────────────────────────────────────────

export async function listTags(): Promise<TagDefinition[]> {
  return get<TagDefinition[]>('/tags');
}

export async function upsertTag(tag: TagDefinition): Promise<void> {
  await post('/tags', tag);
}

export async function deleteTag(name: string): Promise<void> {
  await del(`/tags/${encodeURIComponent(name)}`);
}

export async function renameTag(oldName: string, newName: string): Promise<void> {
  await post('/tags/rename', { oldName, newName });
}

export async function listUntaggedChannels(): Promise<ChannelRecord[]> {
  const all = await listChannels();
  return all.filter((c) => c.tags.length === 0);
}

// ── Settings ─────────────────────────────────────────────────────────────────

export async function getSettings(): Promise<Record<string, unknown>> {
  return get<Record<string, unknown>>('/settings');
}

export async function setSettings(obj: Record<string, unknown>): Promise<void> {
  await put('/settings', obj);
}

// ── Engine state ─────────────────────────────────────────────────────────────

import type { EngineLogEntry, EngineStatus } from './types';

export async function getEngineStatus(): Promise<EngineStatus | null> {
  return get<EngineStatus | null>('/engine/status');
}

export async function setEngineStatus(s: EngineStatus): Promise<void> {
  await put('/engine/status', s);
}

export async function getEngineLog(): Promise<EngineLogEntry[]> {
  return get<EngineLogEntry[]>('/engine/log');
}

export async function setEngineLog(log: EngineLogEntry[]): Promise<void> {
  await put('/engine/log', log);
}

export async function clearEngineLog(): Promise<void> {
  await del('/engine/log');
}

export async function getEnginePending(): Promise<unknown> {
  return get('/engine/pending');
}

export async function setEnginePending(p: unknown): Promise<void> {
  await put('/engine/pending', p);
}

export async function clearEnginePending(): Promise<void> {
  await del('/engine/pending');
}

export async function getBiliBannedUntil(): Promise<number | null> {
  const v = await get<number | null>('/engine/bili-banned');
  return v;
}

export async function setBiliBannedUntil(until: number): Promise<void> {
  await put('/engine/bili-banned', until);
}

export async function clearBiliBannedUntil(): Promise<void> {
  await del('/engine/bili-banned');
}
