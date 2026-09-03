import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { ChannelRecord, SourceKind, TagDefinition, VideoRecord } from './types';

interface FeedTubeDB extends DBSchema {
  channels: { key: string; value: ChannelRecord };
  videos: {
    key: string;
    value: VideoRecord;
    indexes: { by_channel: string; by_published: number };
  };
  tags: { key: string; value: TagDefinition };
}

let dbPromise: Promise<IDBPDatabase<FeedTubeDB>> | null = null;

export function videoStorageKey(source: SourceKind, id: string): string {
  return `${source}:${id}`;
}

function db(): Promise<IDBPDatabase<FeedTubeDB>> {
  dbPromise ??= openDB<FeedTubeDB>('feedtube', 3, {
    async upgrade(d, oldVer, _newVer, tx) {
      if (!d.objectStoreNames.contains('channels')) {
        d.createObjectStore('channels', { keyPath: 'id' });
      }
      if (!d.objectStoreNames.contains('videos')) {
        const videos = d.createObjectStore('videos', { keyPath: 'id' });
        videos.createIndex('by_channel', 'channelId');
        videos.createIndex('by_published', 'publishedAt');
      }
      if (!d.objectStoreNames.contains('tags')) {
        d.createObjectStore('tags', { keyPath: 'name' });
      }
      if (oldVer < 2) {
        const chStore = tx.objectStore('channels') as unknown as {
          openCursor(): Promise<{ value: unknown; update(v: ChannelRecord): Promise<unknown>; delete(): Promise<unknown>; continue(): Promise<unknown> } | null>;
        };
        let cursor = await chStore.openCursor();
        while (cursor) {
          const val = cursor.value as { tags?: string[] } & ChannelRecord;
          if (!val.tags) {
            await cursor.update({ ...val, tags: [] } as ChannelRecord);
          }
          cursor = (await cursor.continue()) as typeof cursor;
        }
      }
      if (oldVer < 3) {
        const chStore = tx.objectStore('channels') as unknown as {
          openCursor(): Promise<{ value: unknown; update(v: ChannelRecord): Promise<unknown>; continue(): Promise<unknown> | undefined } | null>;
        };
        let cursor = await chStore.openCursor();
        while (cursor) {
          const val = cursor.value as ChannelRecord;
          if (!val.source) {
            await cursor.update({ ...val, source: 'youtube' as SourceKind });
          }
          cursor = (await cursor.continue()) as typeof cursor;
        }
        const vStore = tx.objectStore('videos') as unknown as {
          openCursor(): Promise<{ value: unknown; update(v: VideoRecord): Promise<unknown>; delete(): Promise<unknown>; continue(): Promise<unknown> | undefined } | null>;
          put(v: VideoRecord, key: string): Promise<unknown>;
        };
        let vCursor = await vStore.openCursor();
        while (vCursor) {
          const val = vCursor.value as VideoRecord;
          const newKey = videoStorageKey('youtube', val.id);
          if (val.id !== newKey) {
            const updated: VideoRecord = { ...val, source: 'youtube' as SourceKind };
            await vCursor.delete();
            await vStore.put(updated, newKey);
          } else if (!val.source) {
            await vCursor.update({ ...val, source: 'youtube' as SourceKind });
          }
          vCursor = (await vCursor.continue()) as typeof vCursor;
        }
      }
    },
  });
  return dbPromise;
}

export async function upsertChannels(channels: ChannelRecord[]): Promise<void> {
  const d = await db();
  const tx = d.transaction('channels', 'readwrite');
  await Promise.all([...channels.map((c) => tx.store.put(c)), tx.done]);
}

export async function listChannels(): Promise<ChannelRecord[]> {
  const d = await db();
  return d.getAll('channels');
}

export async function getChannel(id: string): Promise<ChannelRecord | undefined> {
  const d = await db();
  return d.get('channels', id);
}

export async function patchChannel(
  id: string,
  patch: Partial<Omit<ChannelRecord, 'id' | 'addedAt'>>,
): Promise<void> {
  const d = await db();
  const cur = await d.get('channels', id);
  if (!cur) return;
  await d.put('channels', { ...cur, ...patch });
}

export async function deleteChannelCascade(id: string): Promise<void> {
  const d = await db();
  const tx = d.transaction(['channels', 'videos'], 'readwrite');
  void tx.objectStore('channels').delete(id);
  let cursor = await tx.objectStore('videos').index('by_channel').openCursor(IDBKeyRange.only(id));
  while (cursor) {
    void cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
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

function mergeVideo(prev: VideoRecord, next: NewVideo): VideoRecord {
  const rssLikeBackend = next.backend === 'rss' || next.backend === 'lbry' || next.backend === 'bili' || next.backend === 'peertube' || next.backend === 'soundcloud';
  const rssDowngrade = rssLikeBackend && prev.backend !== next.backend;
  return {
    id: prev.id,
    source: prev.source,
    channelId: prev.channelId,
    title: next.title || prev.title,
    publishedAt: next.publishedAt ?? prev.publishedAt,
    approxDate:
      next.publishedAt != null ? (rssDowngrade ? prev.approxDate : next.approxDate) : prev.approxDate,
    thumbnailUrl: next.thumbnailUrl ?? prev.thumbnailUrl,
    durationSeconds:
      rssDowngrade && prev.durationSeconds != null
        ? prev.durationSeconds
        : next.durationSeconds ?? prev.durationSeconds,
    viewCount: next.viewCount ?? prev.viewCount,
    kind: rssDowngrade ? prev.kind : next.kind,
    seen: prev.seen,
    seenAt: prev.seenAt,
    backend: rssDowngrade ? prev.backend : next.backend,
    fetchedAt: next.fetchedAt,
  };
}

export async function mergeVideos(incoming: NewVideo[]): Promise<number> {
  if (incoming.length === 0) return 0;
  const d = await db();
  const tx = d.transaction('videos', 'readwrite');
  const store = tx.store;
  let added = 0;
  for (const nv of incoming) {
    const key = videoStorageKey(nv.source, nv.id);
    const prev = await store.get(key);
    if (prev) {
      await store.put(mergeVideo(prev, { ...nv, id: key }));
    } else {
      added++;
      const record: VideoRecord = {
        ...nv,
        id: key,
        seen: false,
        seenAt: null,
      };
      await store.put(record);
    }
  }
  await tx.done;
  return added;
}

export async function listVideos(): Promise<VideoRecord[]> {
  const d = await db();
  return d.getAll('videos');
}

export async function countUnread(): Promise<number> {
  const d = await db();
  let n = 0;
  let cursor = await d.transaction('videos').store.openCursor();
  while (cursor) {
    if (!cursor.value.seen) n++;
    cursor = await cursor.continue();
  }
  return n;
}

export async function setSeen(videoIds: string[], seen: boolean): Promise<void> {
  if (videoIds.length === 0) return;
  const d = await db();
  const tx = d.transaction('videos', 'readwrite');
  const now = Date.now();
  for (const id of videoIds) {
    const v = await tx.store.get(id);
    if (!v || v.seen === seen) continue;
    await tx.store.put({ ...v, seen, seenAt: seen ? now : null });
  }
  await tx.done;
}

export async function markAllSeen(): Promise<void> {
  const d = await db();
  const tx = d.transaction('videos', 'readwrite');
  let cursor = await tx.store.openCursor();
  const now = Date.now();
  while (cursor) {
    if (!cursor.value.seen) {
      await cursor.update({ ...cursor.value, seen: true, seenAt: now });
    }
    cursor = await cursor.continue();
  }
  await tx.done;
}

export async function clearVideos(): Promise<void> {
  const d = await db();
  await d.clear('videos');
}

export async function pruneOldVideos(maxAgeDays: number): Promise<void> {
  if (maxAgeDays <= 0) return;
  const cutoff = Date.now() - maxAgeDays * 86_400_000;
  const d = await db();
  const tx = d.transaction('videos', 'readwrite');
  let cursor = await tx.store.openCursor();
  while (cursor) {
    const pub = cursor.value.publishedAt ?? cursor.value.fetchedAt;
    if (pub < cutoff) void cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
}

export async function listTags(): Promise<TagDefinition[]> {
  const d = await db();
  return d.getAll('tags');
}

export async function upsertTag(tag: TagDefinition): Promise<void> {
  const d = await db();
  await d.put('tags', tag);
}

export async function deleteTag(name: string): Promise<void> {
  const d = await db();
  await d.delete('tags', name);
  const chStore = d.transaction('channels', 'readwrite').store;
  let cursor = await chStore.openCursor();
  while (cursor) {
    const ch = cursor.value;
    if (ch.tags.includes(name)) {
      await cursor.update({ ...ch, tags: ch.tags.filter((t) => t !== name) });
    }
    cursor = await cursor.continue();
  }
}

export async function renameTag(oldName: string, newName: string): Promise<void> {
  const d = await db();
  const old = await d.get('tags', oldName);
  if (!old) return;
  await d.delete('tags', oldName);
  await d.put('tags', { ...old, name: newName });
  const chStore = d.transaction('channels', 'readwrite').store;
  let cursor = await chStore.openCursor();
  while (cursor) {
    const ch = cursor.value;
    if (ch.tags.includes(oldName)) {
      await cursor.update({ ...ch, tags: ch.tags.map((t) => (t === oldName ? newName : t)) });
    }
    cursor = await cursor.continue();
  }
}

export async function listUntaggedChannels(): Promise<ChannelRecord[]> {
  const d = await db();
  const all = await d.getAll('channels');
  return all.filter((c) => c.tags.length === 0);
}

export async function setChannelTags(channelId: string, tags: string[]): Promise<void> {
  const d = await db();
  const ch = await d.get('channels', channelId);
  if (ch) await d.put('channels', { ...ch, tags });
}

export async function markHistoryAsSeen(
  entries: { videoId: string; source: SourceKind; watchedAt: number }[],
): Promise<{ matched: number; total: number }> {
  if (entries.length === 0) return { matched: 0, total: 0 };
  const d = await db();
  const tx = d.transaction('videos', 'readwrite');
  let matched = 0;
  for (const entry of entries) {
    const key = videoStorageKey(entry.source, entry.videoId);
    const v = await tx.store.get(key);
    if (v && !v.seen) {
      matched++;
      await tx.store.put({ ...v, seen: true, seenAt: entry.watchedAt });
    }
  }
  await tx.done;
  return { matched, total: entries.length };
}

export async function listSeenVideos(): Promise<VideoRecord[]> {
  const d = await db();
  const all = await d.getAll('videos');
  return all.filter((v) => v.seen);
}

export async function countSeenVideos(): Promise<number> {
  const d = await db();
  let n = 0;
  let cursor = await d.transaction('videos').store.openCursor();
  while (cursor) {
    if (cursor.value.seen) n++;
    cursor = await cursor.continue();
  }
  return n;
}

export async function clearHistory(): Promise<void> {
  const d = await db();
  const tx = d.transaction('videos', 'readwrite');
  let cursor = await tx.store.openCursor();
  while (cursor) {
    if (cursor.value.seen) {
      await cursor.update({ ...cursor.value, seen: false, seenAt: null });
    }
    cursor = await cursor.continue();
  }
  await tx.done;
}
