import type { ImportedChannel } from '../types';

const UC_RE = /UC[\w-]{22}/;

export function channelIdFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.match(UC_RE)?.[0] ?? null;
}

export function playlistToChannelId(playlistId: string): string | null {
  const m = /^(?:UU(?:LF|SH|LM)?)/.exec(playlistId);
  if (!m) return null;
  return `UC${playlistId.slice(m[0].length)}`;
}

export function dedupeChannels(items: ImportedChannel[]): ImportedChannel[] {
  const seen = new Set<string>();
  const out: ImportedChannel[] = [];
  for (const item of items) {
    const source = item.source ?? 'youtube';
    const key = item.id ? `${source}:${item.id}` : item.url ?? item.name ?? '';
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
