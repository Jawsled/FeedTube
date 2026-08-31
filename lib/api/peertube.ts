import { XMLParser } from 'fast-xml-parser';
import type { ParsedVideo } from '../types';
import { registerSource, type ResolvedChannel, type SourceAdapter, type SourceFetchResult } from './source';

// PeerTube is federated: every instance has its own host. The engine stores
// videos under `peertube:<host>:<videoUuid>` and channels under
// `peertube:<host>@<accountName>`. Host is embedded in the id so the watch
// URL and any later fetches route back to the right instance.

const URL_RE = /^https?:\/\/[^/]+\/(?:@[A-Za-z0-9._-]{1,80}|c\/[A-Za-z0-9._-]{1,80})(\/|$|\?)/i;
const CHANNEL_PATH_RE = /^(?:\/@([^/.\s?#]+)|\/c\/([A-Za-z0-9._-]+))(?:[/?#]|$)/;
const HANDLE_RE = /^[A-Za-z0-9._-]{1,80}$/;
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

interface PeertubeStoredRef {
  host: string;
  accountName: string;
}

function splitStoredChannelId(id: string): PeertubeStoredRef | null {
  if (!id.startsWith('peertube:')) return null;
  const rest = id.slice('peertube:'.length);
  const at = rest.indexOf('@');
  if (at < 0) return null;
  const host = rest.slice(0, at);
  const accountName = rest.slice(at + 1);
  if (!host || !accountName) return null;
  return { host, accountName };
}

function stripProto(host: string): string {
  return host.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
}

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    signal,
    headers: { Accept: 'application/json', 'User-Agent': 'FeedTube/0.1' },
  });
  if (!res.ok) throw new Error(`PeerTube HTTP ${res.status}`);
  return (await res.json()) as T;
}

interface PeertubeAccount {
  id?: number;
  uuid?: string;
  name?: string;
  displayName?: string;
  url?: string;
  host?: string;
  avatars?: { url?: string; width?: number; height?: number }[];
}

function pickAccountAvatar(a: PeertubeAccount): string | null {
  if (!Array.isArray(a.avatars) || a.avatars.length === 0) return null;
  let best: { url?: string; width?: number } | undefined;
  for (const av of a.avatars) {
    if (!best || (av.width ?? 0) > (best.width ?? 0)) best = av;
  }
  const u = best?.url;
  if (typeof u !== 'string' || u.length === 0) return null;
  return u.startsWith('http') ? u : `https:${u.startsWith('//') ? u : `//${u}`}`;
}

async function resolveByUrl(url: string, signal?: AbortSignal): Promise<ResolvedChannel | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const m = parsed.pathname.match(CHANNEL_PATH_RE);
  if (!m) return null;
  const handle = m[1] ?? m[2] ?? '';
  if (!HANDLE_RE.test(handle)) return null;
  const host = stripProto(parsed.hostname);
  return await resolveByHandle(host, handle, signal);
}

async function resolveByHandle(host: string, handle: string, signal?: AbortSignal): Promise<ResolvedChannel | null> {
  if (!HANDLE_RE.test(handle)) return null;
  const data = await fetchJson<PeertubeAccount>(
    `https://${host}/api/v1/accounts/${encodeURIComponent(handle)}`,
    signal,
  );
  if (!data || typeof data !== 'object' || !data.id) return null;
  return {
    id: `peertube:${host}@${handle}`,
    name: data.displayName ?? data.name ?? handle,
    avatarUrl: pickAccountAvatar(data),
    urlSlug: handle,
  };
}

interface AtomEntry {
  id?: string;
  title?: string;
  published?: string;
  updated?: string;
  'media:group'?: {
    'media:thumbnail'?: { '@_url'?: string } | { '@_url'?: string }[];
    'media:content'?: { '@_url'?: string; '@_duration'?: string } | { '@_url'?: string; '@_duration'?: string }[];
  };
  'media:thumbnail'?: { '@_url'?: string } | { '@_url'?: string }[];
  link?: { '@_href'?: string } | { '@_href'?: string }[];
  summary?: string;
}

interface AtomFeed {
  id?: string;
  title?: string;
  entry?: AtomEntry | AtomEntry[];
  icon?: string;
  logo?: string;
}

function toArray<T>(v: T | T[] | undefined): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function firstAttr<T>(v: { '@_href'?: string } | { '@_href'?: string }[] | undefined): T | null {
  const list = toArray(v);
  for (const item of list) {
    const attr = (item as { '@_href'?: string })['@_href'];
    if (typeof attr === 'string' && attr.length > 0) return attr as unknown as T;
  }
  return null;
}

function firstUrl(
  v:
    | { '@_url'?: string }
    | { '@_url'?: string }[]
    | undefined,
): string | null {
  const list = toArray(v);
  for (const item of list) {
    const u = (item as { '@_url'?: string })['@_url'];
    if (typeof u === 'string' && u.length > 0) return u.startsWith('//') ? `https:${u}` : u;
  }
  return null;
}

function durationToSeconds(raw: string | null | undefined): number | null {
  if (!raw) return null;
  if (/^\d+$/.test(raw.trim())) {
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i.exec(raw.trim());
  if (!m) return null;
  const h = parseInt(m[1] ?? '0', 10);
  const mm = parseInt(m[2] ?? '0', 10);
  const s = parseInt(m[3] ?? '0', 10);
  const total = h * 3600 + mm * 60 + s;
  return total > 0 ? total : null;
}

function pickUuidFromText(text: string | undefined): string | null {
  if (!text) return null;
  const m = /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i.exec(text);
  return m ? m[1] : null;
}

function rssEntryToVideo(e: AtomEntry, host: string): ParsedVideo | null {
  const linkHref = firstAttr<string>(e.link);
  const uuid = pickUuidFromText(e.id) ?? pickUuidFromText(linkHref ?? undefined);
  if (!uuid || !UUID_RE.test(uuid)) return null;
  const group = e['media:group'];
  const thumb = (group && firstUrl(group['media:thumbnail'])) ?? firstUrl(e['media:thumbnail']);
  const content = group ? toArray(group['media:content'])[0] : undefined;
  const duration = durationToSeconds(content?.['@_duration']);
  const published = e.published ? Date.parse(e.published) : NaN;
  const titleRaw = typeof e.title === 'string' ? e.title : '';
  const title = titleMatch(titleRaw);
  return {
    // Embed the instance host so watchUrl can route the user back to the
    // right instance without needing a separate lookup table.
    id: `${host}:${uuid}`,
    title,
    publishedAt: Number.isFinite(published) ? published : null,
    approxDate: false,
    durationSeconds: duration,
    viewCount: null,
    kind: 'video',
    thumbnailUrl: thumb,
  };
}

function titleMatch(raw: string): string {
  return raw.replace(/<!\[CDATA\[(.*?)\]\]>/s, '$1').trim();
}

async function fetchRss(host: string, handle: string, signal?: AbortSignal): Promise<{ name: string | null; avatarUrl: string | null; videos: ParsedVideo[]; atomDoc: AtomFeed }> {
  const url = `https://${host}/feeds/accounts/${encodeURIComponent(handle)}.atom`;
  const res = await fetch(url, { signal, headers: { Accept: 'application/atom+xml, application/xml' } });
  if (!res.ok) throw new Error(`PeerTube RSS HTTP ${res.status}`);
  const xml = await res.text();
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', trimValues: true });
  const doc = parser.parse(xml) as { feed?: AtomFeed };
  const feed = doc.feed;
  const videos: ParsedVideo[] = [];
  for (const e of toArray(feed?.entry)) {
    const v = rssEntryToVideo(e, host);
    if (v) videos.push(v);
  }
  return {
    name: typeof feed?.title === 'string' ? feed.title.replace(/<!\[CDATA\[(.*?)\]\]>/s, '$1').trim() : null,
    avatarUrl: feed?.logo ?? feed?.icon ?? null,
    videos,
    atomDoc: feed ?? {},
  };
}

interface ApiVideo {
  id?: number;
  uuid?: string;
  name?: string;
  title?: string;
  publishedAt?: string;
  duration?: number;
  views?: number;
  thumbnailPath?: string;
  previewPath?: string;
}

function apiVideoToVideo(v: ApiVideo, host: string): ParsedVideo | null {
  const uuid = v.uuid;
  if (!uuid || !UUID_RE.test(uuid)) return null;
  const title = (v.name ?? v.title ?? '').trim();
  if (!title) return null;
  const published = v.publishedAt ? Date.parse(v.publishedAt) : NaN;
  const base = `https://${host}`;
  const thumbPath = v.thumbnailPath ?? v.previewPath ?? null;
  return {
    id: `${host}:${uuid}`,
    title,
    publishedAt: Number.isFinite(published) ? published : null,
    approxDate: false,
    durationSeconds: typeof v.duration === 'number' && v.duration > 0 ? v.duration : null,
    viewCount: typeof v.views === 'number' && v.views >= 0 ? v.views : null,
    kind: 'video',
    thumbnailUrl: thumbPath ? `${base}${thumbPath.startsWith('/') ? '' : '/'}${thumbPath}` : null,
  };
}

async function fetchViaApi(host: string, handle: string, signal?: AbortSignal, limit?: number): Promise<{ name: string | null; avatarUrl: string | null; videos: ParsedVideo[] }> {
  const list = await fetchJson<ApiVideo[]>(
    `https://${host}/api/v1/accounts/${encodeURIComponent(handle)}/videos?count=${limit ?? 30}&sort=-publishedAt`,
    signal,
  );
  const acct = await fetchJson<PeertubeAccount>(
    `https://${host}/api/v1/accounts/${encodeURIComponent(handle)}`,
    signal,
  );
  return {
    name: acct?.displayName ?? acct?.name ?? handle,
    avatarUrl: pickAccountAvatar(acct ?? {}),
    videos: (list ?? []).map((v) => apiVideoToVideo(v, host)).filter((v): v is ParsedVideo => v != null),
  };
}

export const peertubeAdapter: SourceAdapter = {
  kind: 'peertube',
  watchUrl(videoId, _kind) {
    // Storage key shape: peertube:<host>:<videoUuid>
    if (!videoId.startsWith('peertube:')) return `https://peertube.tv/videos/watch/${videoId}`;
    const rest = videoId.slice('peertube:'.length);
    const colon = rest.indexOf(':');
    if (colon < 0) return `https://${rest}`;
    const host = rest.slice(0, colon);
    const uuid = rest.slice(colon + 1);
    return `https://${host}/videos/watch/${uuid}`;
  },
  channelUrl(id) {
    const ref = splitStoredChannelId(id);
    if (!ref) return `https://peertube.tv/@${id}`;
    return `https://${ref.host}/@${ref.accountName}`;
  },
  videoIdForStorage(rawId) {
    // No-op: the engine keys videos with `${source}:${id}` already, so we
    // just return the bare uuid.
    return rawId;
  },
  videoIdFromStorage(stored) {
    // `peertube:<host>:<uuid>` (full key) or `<uuid>` → uuid
    const rest = stored.replace(/^peertube:/, '');
    const colon = rest.indexOf(':');
    return colon < 0 ? rest : rest.slice(colon + 1);
  },
  detectInput(rawInput) {
    const t = rawInput.trim();
    if (t.length === 0) return false;
    if (URL_RE.test(t)) return true;
    return false;
  },
  async resolveChannel(rawInput, signal) {
    const t = rawInput.trim();
    if (!URL_RE.test(t)) {
      throw new Error('PeerTube input must be a full URL like https://<instance>/@<handle>');
    }
    const r = await resolveByUrl(t, signal);
    if (r) return r;
    throw new Error('Not a recognizable PeerTube account URL');
  },
  async fetchChannel(id, signal, hint) {
    const ref = splitStoredChannelId(id);
    if (!ref) throw new Error(`Invalid PeerTube channel id: ${id}`);
    const handle = hint?.urlSlug ?? ref.accountName;
    let backendDetail = 'rss';
    let name: string | null = hint?.name ?? null;
    let avatarUrl: string | null = hint?.avatarUrl ?? null;
    let videos: ParsedVideo[] = [];
    try {
      const rss = await fetchRss(ref.host, handle, signal);
      name = name ?? rss.name;
      avatarUrl = avatarUrl ?? rss.avatarUrl;
      videos = hint?.limit ? rss.videos.slice(0, hint.limit) : rss.videos;
    } catch {
      // Some instances don't enable RSS feeds; fall back to the JSON API.
      backendDetail = 'api';
      const api = await fetchViaApi(ref.host, handle, signal, hint?.limit);
      name = name ?? api.name;
      avatarUrl = avatarUrl ?? api.avatarUrl;
      videos = api.videos;
    }
    return {
      videos,
      name,
      avatarUrl,
      kind: 'peertube',
      backendDetail,
    };
  },
};

registerSource(peertubeAdapter);
