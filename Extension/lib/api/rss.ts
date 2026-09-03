import { XMLParser } from 'fast-xml-parser';
import type { ParsedVideo } from '../types';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
});

function toArray<T>(v: T | T[] | undefined): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

export interface RssResult {
  name: string | null;
  videos: ParsedVideo[];
}

function numOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export async function fetchChannelRss(channelId: string, signal?: AbortSignal): Promise<RssResult> {
  const res = await fetch(
    `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`,
    { signal },
  );
  if (!res.ok) throw new Error(`RSS HTTP ${res.status}`);
  const xml = await res.text();

  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch {
    throw new Error('RSS returned invalid XML');
  }

  const feed = doc.feed as Record<string, unknown> | undefined;
  if (!feed) throw new Error('RSS response missing feed element');

  const author = feed.author as Record<string, unknown> | undefined;
  const name = typeof author?.name === 'string' ? author.name : null;

  const videos: ParsedVideo[] = [];
  for (const entry of toArray(feed.entry as Record<string, unknown>[])) {
    const id = typeof entry['yt:videoId'] === 'string' ? entry['yt:videoId'] : null;
    if (!id) continue;
    const group = entry['media:group'] as Record<string, unknown> | undefined;
    const community = group?.['media:community'] as Record<string, unknown> | undefined;
    const stats = community?.['media:statistics'] as Record<string, unknown> | undefined;
    const thumb = group?.['media:thumbnail'] as Record<string, unknown> | undefined;
    const publishedRaw = typeof entry.published === 'string' ? entry.published : null;
    const publishedAt = publishedRaw != null ? Date.parse(publishedRaw) : NaN;

    videos.push({
      id,
      title: typeof entry.title === 'string' ? entry.title : '',
      publishedAt: Number.isFinite(publishedAt) ? publishedAt : null,
      approxDate: false,
      durationSeconds: null,
      viewCount: numOrNull(stats?.['@_views']),
      kind: 'video',
      thumbnailUrl:
        typeof thumb?.['@_url'] === 'string' && thumb['@_url'].startsWith('http')
          ? (thumb['@_url'] as string)
          : `https://i.ytimg.com/vi/${id.replace(/^youtube:/, '')}/hqdefault.jpg`,
    });
  }
  return { name, videos };
}

export async function detectChannelCategory(channelId: string, signal?: AbortSignal): Promise<string | null> {
  let doc: Record<string, unknown>;
  try {
    const res = await fetch(
      `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`,
      { signal },
    );
    if (!res.ok) return null;
    doc = parser.parse(await res.text()) as Record<string, unknown>;
  } catch {
    return null;
  }

  const feed = doc.feed as Record<string, unknown> | undefined;
  if (!feed) return null;

  const entries = toArray(feed.entry as Record<string, unknown>[]);
  for (const entry of entries.slice(0, 1)) {
    const videoId = typeof entry['yt:videoId'] === 'string' ? entry['yt:videoId'] : null;
    if (!videoId) continue;
    try {
      const playerRes = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          context: { client: { clientName: 'WEB', clientVersion: '2.20260818.01.00' } },
          videoId,
        }),
        signal,
      });
      if (!playerRes.ok) continue;
      const playerJson = await playerRes.json() as Record<string, unknown>;
      const micro = playerJson.microformat as Record<string, unknown> | undefined;
      const renderer = micro?.playerMicroformatRenderer as Record<string, unknown> | undefined;
      const category = typeof renderer?.category === 'string' ? renderer.category : null;
      if (category && category !== 'People & Blogs') return category;
    } catch {
      continue;
    }
  }
  return null;
}
