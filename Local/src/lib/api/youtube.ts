import { apiFetch } from '../platform';
import type { ParsedVideo, VideoKind } from '../types';
import { deepCollect, deepGet, hmsToSeconds, parseCount, relativeToEpoch } from '../utils';
import { registerSource, type ResolvedChannel, type SourceAdapter, type SourceFetchResult } from './source';

const BROWSE_URL = 'https://www.youtube.com/youtubei/v1/browse?prettyPrint=false';

export const INNERTUBE_CLIENT_VERSION = '2.20260818.01.00';

const CLIENT = {
  clientName: 'WEB',
  clientVersion: INNERTUBE_CLIENT_VERSION,
  hl: 'en',
  gl: 'US',
};

const TAB_PARAMS: Record<string, string> = {
  videos: 'EgZ2aWRlb3PyBgQKAjoA',
  shorts: 'EgZzaG9ydHPyBgUKA5oBAA==',
  streams: 'EgdzdHJlYW1z8gYECgJ6AA==',
};

export type BrowseTab = keyof typeof TAB_PARAMS | 'home';

const UC_RE = /UC[\w-]{22}/;
const URL_RE = /^https?:\/\//i;
const YOUTUBE_HOSTS = /(^|\.)(youtube\.com|youtu\.be)$/i;

function textOf(node: unknown): string | null {
  if (node == null) return null;
  if (typeof node === 'string') return node;
  if (typeof node === 'object') {
    const o = node as Record<string, unknown>;
    if (typeof o.simpleText === 'string') return o.simpleText;
    if (typeof o.content === 'string') return o.content;
    if (Array.isArray(o.runs)) {
      return o.runs.map((r) => (r as { text?: string })?.text ?? '').join('');
    }
  }
  return null;
}

function bestThumb(list: unknown): string | null {
  if (!Array.isArray(list) || list.length === 0) return null;
  let best: { url?: string; width?: number } | undefined;
  for (const t of list as { url?: string; width?: number }[]) {
    if (!best || (t.width ?? 0) > (best.width ?? 0)) best = t;
  }
  const url = best?.url;
  if (typeof url === 'string' && url.length > 0) return url.startsWith('//') ? `https:${url}` : url;
  return null;
}

export function fallbackThumb(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId.replace(/^youtube:/, '')}/hqdefault.jpg`;
}

interface ParseCtx {
  out: Map<string, ParsedVideo>;
}

function push(ctx: ParseCtx, v: ParsedVideo | null) {
  if (!v || !v.id || !/^[\w-]{11}$/.test(v.id)) return;
  const existing = ctx.out.get(v.id);
  if (!existing || scoreOf(v) > scoreOf(existing)) ctx.out.set(v.id, v);
}

function scoreOf(v: ParsedVideo): number {
  return (
    (v.durationSeconds != null ? 1 : 0) +
    (v.publishedAt != null ? 2 : 0) +
    (v.viewCount != null ? 1 : 0)
  );
}

function badgeStrings(root: unknown): string[] {
  const out: string[] = [];
  for (const b of deepCollect(root, 'metadataBadgeRenderer')) {
    const t = textOf((b as Record<string, unknown>)?.label);
    if (t) out.push(t);
  }
  for (const b of deepCollect(root, 'thumbnailBadgeViewModel')) {
    const t = textOf(b);
    if (t) out.push(t);
  }
  for (const b of deepCollect(root, 'thumbnailOverlayBadgeViewModel')) {
    for (const s of deepCollect(b, 'thumbnailBadgeViewModel')) {
      const t = textOf(s);
      if (t) out.push(t);
    }
  }
  return out;
}

function kindFromBadges(badges: string[], contentType: string): VideoKind | null {
  const upper = badges.map((b) => b.toUpperCase());
  if (upper.includes('LIVE')) return 'live';
  if (/LIVE/.test(contentType.toUpperCase())) return 'live';
  if (/SHORT/.test(contentType.toUpperCase())) return 'short';
  return null;
}

function metaPartsStrings(lockup: unknown): string[] {
  const rows = deepCollect(lockup, 'metadataParts');
  const out: string[] = [];
  for (const row of rows.flat()) {
    const t = textOf((row as Record<string, unknown>)?.text);
    if (t) out.push(t);
  }
  return out;
}

function extractViewsAndDate(strs: string[]): { viewCount: number | null; publishedAt: number | null } {
  let viewCount: number | null = null;
  let publishedAt: number | null = null;
  for (const s of strs) {
    if (viewCount == null && /view/i.test(s)) viewCount = parseCount(s);
    else if (publishedAt == null) {
      const ts = relativeToEpoch(s);
      if (ts != null) publishedAt = ts;
    }
  }
  return { viewCount, publishedAt };
}

function parseVideoRenderer(vr: Record<string, unknown>): ParsedVideo | null {
  const id = typeof vr.videoId === 'string' ? vr.videoId : null;
  if (!id) return null;
  const badges = badgeStrings(vr);
  const durationSeconds = hmsToSeconds(textOf(vr.lengthText));
  const upcoming = vr.upcomingEventData != null || /UPCOMING/i.test(badges.join('|'));
  let kind: VideoKind = 'video';
  if (upcoming) kind = 'live';
  else {
    kind = kindFromBadges(badges, '') ?? 'video';
  }
  const pubRel = textOf(vr.publishedTimeText);
  return {
    id,
    title: textOf(vr.title) ?? '',
    publishedAt: upcoming ? null : relativeToEpoch(pubRel),
    approxDate: true,
    durationSeconds,
    viewCount: parseCount(textOf(vr.viewCountText)),
    kind,
    thumbnailUrl: bestThumb(deepGet(vr, ['thumbnail', 'thumbnails'])) ?? fallbackThumb(id),
  };
}

function parseLockupViewModel(lv: Record<string, unknown>): ParsedVideo | null {
  let id = typeof lv.contentId === 'string' && lv.contentId.length > 0 ? lv.contentId : null;
  if (!id) {
    const fromTap = deepCollect(lv, 'videoId').find(
      (v): v is string => typeof v === 'string' && /^[\w-]{11}$/.test(v),
    );
    id = fromTap ?? null;
  }
  if (!id) return null;

  const contentType = typeof lv.contentType === 'string' ? lv.contentType : '';
  const badges = badgeStrings(lv);
  let durationSeconds: number | null = null;
  for (const b of badges) {
    const d = hmsToSeconds(b);
    if (d != null) {
      durationSeconds = d;
      break;
    }
  }

  const meta = deepGet(lv, ['metadata', 'lockupMetadataViewModel']);
  const title = textOf(deepGet(meta as unknown, ['title']));
  const parts = metaPartsStrings(lv);
  const { viewCount, publishedAt } = extractViewsAndDate(parts);

  let kind = kindFromBadges(badges, contentType);
  if (kind == null) {
    const isReel = deepCollect(lv, 'reelWatchEndpoint').length > 0;
    kind = isReel ? 'short' : durationSeconds != null && durationSeconds <= 61 ? 'video' : 'video';
  }

  const thumbSources = deepCollect(deepGet(lv, ['contentImage']), 'sources')
    .flat()
    .filter((s): s is Record<string, unknown> => s != null && typeof s === 'object');

  return {
    id,
    title: title ?? '',
    publishedAt,
    approxDate: true,
    durationSeconds,
    viewCount,
    kind,
    thumbnailUrl: bestThumb(thumbSources) ?? fallbackThumb(id),
  };
}

function parseReelItem(r: Record<string, unknown>): ParsedVideo | null {
  const id = typeof r.videoId === 'string' ? r.videoId : null;
  if (!id) return null;
  return {
    id,
    title: textOf(r.headline) ?? '',
    publishedAt: relativeToEpoch(textOf(r.displayFullPublishedIfExists)),
    approxDate: true,
    durationSeconds: null,
    viewCount: parseCount(textOf(r.viewCountText)),
    kind: 'short',
    thumbnailUrl: bestThumb(deepGet(r, ['thumbnail', 'thumbnails'])) ?? fallbackThumb(id),
  };
}

export function parseChannelMeta(json: unknown): { name: string | null; avatarUrl: string | null } {
  const meta = deepGet(json, ['metadata', 'channelMetadataRenderer']) as Record<string, unknown> | undefined;
  const name = typeof meta?.title === 'string' ? meta.title : null;
  const avatarUrl = bestThumb(deepGet(meta, ['avatar', 'thumbnails']));
  if (name == null) {
    const headerTitle = deepGet(json, [
      'header',
      'pageHeaderRenderer',
      'pageTitle',
    ]);
    return { name: typeof headerTitle === 'string' ? headerTitle : null, avatarUrl };
  }
  return { name, avatarUrl };
}

export function parseChannelVideos(json: unknown): ParsedVideo[] {
  const ctx: ParseCtx = { out: new Map() };

  const richItems = deepCollect(json, 'richItemRenderer');
  for (const item of richItems) {
    const content = (item as Record<string, unknown>)?.content as Record<string, unknown> | undefined;
    if (!content || typeof content !== 'object') continue;
    if (content.videoRenderer) push(ctx, parseVideoRenderer(content.videoRenderer as Record<string, unknown>));
    else if (content.lockupViewModel)
      push(ctx, parseLockupViewModel(content.lockupViewModel as Record<string, unknown>));
    else if (content.reelItemRenderer)
      push(ctx, parseReelItem(content.reelItemRenderer as Record<string, unknown>));
  }

  for (const gvr of deepCollect(json, 'gridVideoRenderer')) {
    push(ctx, parseVideoRenderer(gvr as Record<string, unknown>));
  }
  for (const gri of deepCollect(json, 'gridReelItemRenderer')) {
    push(ctx, parseReelItem(gri as Record<string, unknown>));
  }

  return [...ctx.out.values()];
}

export async function browseChannel(channelId: string, tab: BrowseTab, signal?: AbortSignal): Promise<unknown> {
  const body: Record<string, unknown> = { context: { client: CLIENT }, browseId: channelId };
  if (tab !== 'home') body.params = TAB_PARAMS[tab];
  const res = await apiFetch(BROWSE_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-youtube-client-name': '1',
      'x-youtube-client-version': CLIENT.clientVersion,
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`YouTube API HTTP ${res.status}`);
  return res.json();
}

function buildCandidates(url: URL): string[] {
  const segs = url.pathname.split('/').filter(Boolean);
  const first = segs[0] ?? '';
  const rest = segs.slice(1).join('/');
  const out: string[] = [url.origin + url.pathname];

  if (first === 'c' && rest) {
    out.push(`https://www.youtube.com/@${rest}`);
    out.push(`https://www.youtube.com/user/${rest}`);
  } else if (first === 'user' && rest) {
    out.push(`https://www.youtube.com/@${rest}`);
  } else if (!first.startsWith('@') && first && !['watch', 'shorts', 'playlist', 'feed'].includes(first)) {
    out.push(`https://www.youtube.com/@${first}`);
  }
  return out;
}

const RESOLVE_URL_ENDPOINT = 'https://www.youtube.com/youtubei/v1/navigation/resolve_url?prettyPrint=false';

async function resolveUrlViaApi(url: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const res = await apiFetch(RESOLVE_URL_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        context: { client: { clientName: 'WEB', clientVersion: '2.20260818.01.00', hl: 'en', gl: 'US' } },
        url,
      }),
      signal,
    });
    if (!res.ok) return null;
    const j = (await res.json()) as {
      endpoint?: { browseEndpoint?: { browseId?: string } };
    };
    const id = j.endpoint?.browseEndpoint?.browseId;
    return id && UC_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

async function scrapeCanonical(url: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const res = await apiFetch(url, { signal });
    if (!res.ok) return null;
    const html = await res.text();
    const external =
      html.match(/"externalId"\s*:\s*"(UC[\w-]{22})"/)?.[1] ??
      html.match(/<link[^>]+rel="canonical"[^>]+href="[^"]*channel\/(UC[\w-]{22})"/)?.[1] ??
      html.match(/<meta[^>]+property="og:url"[^>]+content="[^"]*channel\/(UC[\w-]{22})"/)?.[1];
    return external ?? null;
  } catch {
    return null;
  }
}

export const youtubeAdapter: SourceAdapter = {
  kind: 'youtube',
  watchUrl(videoId) {
    return `https://www.youtube.com/watch?v=${videoId.replace(/^youtube:/, '')}`;
  },
  channelUrl(id) {
    return `https://www.youtube.com/channel/${id.replace(/^youtube:/, '')}`;
  },
  videoIdForStorage(raw) {
    return raw.replace(/^youtube:/, '');
  },
  videoIdFromStorage(stored) {
    return stored;
  },
  detectInput(raw) {
    const input = raw.trim();
    if (input.length === 0) return false;
    if (URL_RE.test(input)) {
      try {
        const url = new URL(input);
        const host = url.hostname.replace(/^(www|m)\./, '');
        return YOUTUBE_HOSTS.test(host);
      } catch {
        return false;
      }
    }
    if (UC_RE.test(input)) return true;
    if (input.startsWith('@') || /^[\w.\-]+$/.test(input)) return true;
    return false;
  },
  async resolveChannel(rawInput, signal) {
    const input = rawInput.trim();
    if (input.length === 0) throw new Error('Empty channel input');

    if (UC_RE.test(input)) return { id: input, name: null, avatarUrl: null };

    const uc = input.match(UC_RE)?.[0] ?? null;

    if (URL_RE.test(input)) {
      let url: URL;
      try {
        url = new URL(input);
      } catch {
        throw new Error('Invalid URL');
      }
      const host = url.hostname.replace(/^(www|m)\./, '');
      if (!YOUTUBE_HOSTS.test(host)) {
        throw new Error('Not a YouTube URL');
      }

      const segs = url.pathname.split('/').filter(Boolean);
      const first = segs[0] ?? '';

      if (first === 'channel') {
        if (uc) return { id: uc, name: null, avatarUrl: null };
        throw new Error('URL is missing the channel ID');
      }

      const candidates = buildCandidates(url);
      for (const candidate of candidates) {
        const id = (await resolveUrlViaApi(candidate, signal)) ?? (await scrapeCanonical(candidate, signal));
        if (id) return { id, name: null, avatarUrl: null };
      }
      if (uc) return { id: uc, name: null, avatarUrl: null };
      throw new Error(
        'Could not resolve that URL to a channel. Try youtube.com/@handle or youtube.com/channel/UC…',
      );
    }

    if (input.startsWith('@') || /^[\w.\-]+$/.test(input)) {
      const handle = input.startsWith('@') ? input.slice(1) : input;
      const candidates = [`https://www.youtube.com/@${handle}`, `https://www.youtube.com/user/${handle}`];
      for (const candidate of candidates) {
        const id = (await resolveUrlViaApi(candidate, signal)) ?? (await scrapeCanonical(candidate, signal));
        if (id) return { id, name: null, avatarUrl: null };
      }
      throw new Error(`Could not find a channel for "${input}"`);
    }

    throw new Error('Unrecognized channel format');
  },
  async fetchChannel(id, signal, hint): Promise<SourceFetchResult> {
    const json = await browseChannel(id, 'videos', signal);
    let videos = parseChannelVideos(json);
    if (hint?.limit && videos.length > hint.limit) videos = videos.slice(0, hint.limit);
    const meta = parseChannelMeta(json);
    return { videos, name: meta.name, avatarUrl: meta.avatarUrl, kind: 'youtube' };
  },
};

registerSource(youtubeAdapter);
