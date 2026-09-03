import { apiFetch } from '../platform';
import type { ParsedVideo, VideoKind } from '../types';

export function normalizeInstance(input: string): string {
  let s = input.trim();
  if (s.length === 0) throw new Error('Instance URL is empty');
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  s = s.replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(s);
  } catch {
    throw new Error('Invalid instance URL');
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new Error('Instance URL should be the site root');
  }
  return `${parsed.protocol}//${parsed.host}`;
}

function timeoutSignal(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

export async function testInvidiousInstance(base: string): Promise<{ version: string }> {
  const res = await apiFetch(`${base}/api/v1/stats`, { signal: timeoutSignal(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = (await res.json()) as { software?: { name?: string; version?: string } };
  const name = j.software?.name?.toLowerCase() ?? '';
  if (!name.includes('invidious')) throw new Error('Endpoint is not an Invidious instance');
  return { version: j.software?.version ?? 'unknown' };
}

interface InvidiousThumb {
  quality: string;
  url: string;
  width: number;
}

function pickThumbnail(thumbs: InvidiousThumb[] | undefined): string | null {
  if (!Array.isArray(thumbs) || thumbs.length === 0) return null;
  const preferred = ['maxresdefault', 'sddefault', 'high', 'medium'];
  for (const q of preferred) {
    const t = thumbs.find((x) => x.quality === q);
    if (t?.url) return absolutize(t.url);
  }
  return absolutize(thumbs[thumbs.length - 1]?.url ?? '');
}

function absolutize(url: string): string | null {
  if (!url) return null;
  return url.startsWith('//') ? `https:${url}` : url;
}

export interface InvidiousChannelInfo {
  name: string;
  avatarUrl: string | null;
}

export async function invidiousChannelInfo(
  base: string,
  channelId: string,
  signal?: AbortSignal,
): Promise<InvidiousChannelInfo> {
  const res = await apiFetch(`${base}/api/v1/channels/${encodeURIComponent(channelId)}`, { signal });
  if (!res.ok) throw new Error(`Invidious HTTP ${res.status}`);
  const j = (await res.json()) as {
    author?: string;
    authorThumbnails?: InvidiousThumb[];
    error?: string;
  };
  if (j.error) throw new Error(j.error);
  if (!j.author) throw new Error('Channel not found on instance');
  return { name: j.author, avatarUrl: pickThumbnail(j.authorThumbnails) };
}

export async function invidiousResolveHandle(
  base: string,
  handle: string,
  signal?: AbortSignal,
): Promise<{ channelId: string; info: InvidiousChannelInfo }> {
  const clean = handle.replace(/^@/, '');
  const res = await apiFetch(`${base}/api/v1/search?q=${encodeURIComponent(clean)}&type=channel`, {
    signal,
  });
  if (!res.ok) throw new Error(`Invidious HTTP ${res.status}`);
  const results = (await res.json()) as { authorId?: string; author?: string }[];
  const hit = results.find((r) => r.authorId);
  if (!hit?.authorId) throw new Error('No channel match found on instance');
  return {
    channelId: hit.authorId,
    info: { name: hit.author ?? hit.authorId, avatarUrl: null },
  };
}

interface InvidiousVideo {
  videoId?: string;
  title?: string;
  lengthSeconds?: number;
  viewCount?: number;
  published?: number;
  liveNow?: boolean;
  isUpcoming?: boolean;
  videoThumbnails?: InvidiousThumb[];
}

export async function invidiousChannelLatest(
  base: string,
  channelId: string,
  signal?: AbortSignal,
): Promise<ParsedVideo[]> {
  const res = await apiFetch(`${base}/api/v1/channels/${encodeURIComponent(channelId)}/latest`, {
    signal,
  });
  if (!res.ok) throw new Error(`Invidious HTTP ${res.status}`);
  const arr = (await res.json()) as InvidiousVideo[];
  if (!Array.isArray(arr)) throw new Error('Unexpected Invidious response shape');

  const out: ParsedVideo[] = [];
  for (const v of arr) {
    if (!v.videoId) continue;
    let kind: VideoKind = 'video';
    if (v.liveNow) kind = 'live';
    else if (/shorts?/i.test(v.title ?? '')) kind = 'video';
    out.push({
      id: v.videoId,
      title: v.title ?? '',
      publishedAt: v.isUpcoming ? null : typeof v.published === 'number' ? v.published * 1000 : null,
      approxDate: false,
      durationSeconds:
        typeof v.lengthSeconds === 'number' && v.lengthSeconds > 0 ? v.lengthSeconds : null,
      viewCount: typeof v.viewCount === 'number' ? v.viewCount : null,
      kind,
      thumbnailUrl: pickThumbnail(v.videoThumbnails),
    });
  }
  return out;
}
