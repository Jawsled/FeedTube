import type { ImportedChannel } from '../types';
import { dedupeChannels } from './common';

interface TakeoutSubscription {
  snippet?: {
    title?: string;
    resourceId?: { channelId?: string };
    thumbnails?: Record<string, { url?: string }>;
  };
}

function extract(items: unknown[]): ImportedChannel[] {
  const out: ImportedChannel[] = [];
  for (const item of items) {
    const s = (item as TakeoutSubscription)?.snippet;
    const id = s?.resourceId?.channelId;
    if (!id || !/^UC[\w-]{22}$/.test(id)) continue;
    out.push({
      id,
      url: `https://www.youtube.com/channel/${id}`,
      name: typeof s?.title === 'string' ? s.title : null,
      avatarUrl: s?.thumbnails?.default?.url ?? s?.thumbnails?.high?.url ?? null,
    });
  }
  return dedupeChannels(out);
}

export function parseTakeoutJson(text: string): ImportedChannel[] {
  const j = JSON.parse(text) as unknown;
  if (Array.isArray(j)) return extract(j);
  if (j && typeof j === 'object') {
    const subs = (j as { subscriptions?: unknown }).subscriptions;
    if (Array.isArray(subs)) return extract(subs);
  }
  throw new Error('JSON does not look like a YouTube subscriptions export');
}
