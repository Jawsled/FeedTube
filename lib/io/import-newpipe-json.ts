import type { ImportedChannel } from '../types';
import { channelIdFromUrl, dedupeChannels } from './common';

interface NewPipeSubscription {
  service_id?: number;
  url?: string;
  name?: string;
  avatar_url?: string;
}

const SERVICE_YOUTUBE = 0;

export function parseNewPipeJson(text: string): ImportedChannel[] {
  const j = JSON.parse(text) as { subscriptions?: NewPipeSubscription[] };
  const subs = Array.isArray(j.subscriptions) ? j.subscriptions : [];
  const items: ImportedChannel[] = [];
  for (const s of subs) {
    if (s.service_id !== SERVICE_YOUTUBE) continue;
    items.push({
      id: channelIdFromUrl(s.url),
      url: s.url ?? null,
      name: s.name ?? null,
      avatarUrl: s.avatar_url ?? null,
    });
  }
  return dedupeChannels(items);
}
