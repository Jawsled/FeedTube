import type { ParsedVideo, VideoKind } from '../types';
import { XMLParser } from 'fast-xml-parser';
import { registerSource, type ResolvedChannel, type SourceAdapter, type SourceFetchResult } from './source';

const HANDLE_RE = /^@[A-Za-z0-9_-]{1,30}(?::[a-f0-9]+)?$/;
const CLAIM_ID_RE = /^[a-f0-9]{40}$/;
const URL_RE = /^https?:\/\/(?:www\.)?odysee\.com\//i;

interface ParsedRssChannel {
  title?: string;
  'itunes:author'?: string;
  'itunes:image'?: { '@_href'?: string } | string;
  link?: string;
  item?: RssEntry | RssEntry[];
}

interface ParsedRss {
  feed?: ParsedRssChannel;
  rss?: { channel?: ParsedRssChannel };
}

interface RssEntry {
  title?: string;
  link?: string;
  guid?: string;
  pubDate?: string;
  'itunes:duration'?: string;
  'itunes:image'?: { '@_href'?: string } | string;
  description?: string;
  enclosure?: { '@_url'?: string; '@_length'?: string };
}

function toArray<T>(v: T | T[] | undefined): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function pickThumb(v: RssEntry['itunes:image']): string | null {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && typeof v['@_href'] === 'string') return v['@_href'];
  return null;
}

function pickLinkClaimId(link: string | undefined): string | null {
  if (!link) return null;
  const m = /odysee\.com\/[^:]+:([a-f0-9]{40})/i.exec(link);
  if (m) return m[1];
  const m2 = /:([a-f0-9]{40})/i.exec(link);
  return m2 ? m2[1] : null;
}

function durationToSeconds(v: string | undefined): number | null {
  if (!v) return null;
  if (/^\d+$/.test(v.trim())) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  const parts = v.split(':').map((x) => parseInt(x, 10));
  if (parts.some((p) => Number.isNaN(p))) return null;
  let s = 0;
  for (const p of parts) s = s * 60 + p;
  return s > 0 ? s : null;
}

function kindFromEntry(e: RssEntry, duration: number | null): VideoKind {
  if (duration != null && duration <= 61) return 'short';
  return 'video';
}

function rssToVideo(e: RssEntry): ParsedVideo | null {
  const claimId = pickLinkClaimId(e.link) ?? pickLinkClaimId(e.guid);
  if (!claimId) return null;
  const titleMatch = e.title?.match(/<!\[CDATA\[(.*?)\]\]>/);
  const title = titleMatch ? titleMatch[1] : e.title ?? '';
  const duration = durationToSeconds(typeof e['itunes:duration'] === 'string' ? e['itunes:duration'] : undefined);
  const pub = e.pubDate ? Date.parse(e.pubDate) : NaN;
  const thumb = pickThumb(e['itunes:image']);
  return {
    id: claimId,
    title: title.trim(),
    publishedAt: Number.isFinite(pub) ? pub : null,
    approxDate: false,
    durationSeconds: duration,
    viewCount: null,
    kind: kindFromEntry(e, duration),
    thumbnailUrl: thumb,
  };
}

async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(url, { signal, redirect: 'follow' });
  if (!res.ok) throw new Error(`Odysee HTTP ${res.status}`);
  return res.text();
}

async function rssFetch(handleRef: string, signal?: AbortSignal): Promise<{ name: string | null; avatarUrl: string | null; videos: ParsedVideo[]; htmlForMeta: string }> {
  const xml = await fetchText(`https://lbry.tv/$/rss/${handleRef}`, signal);
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', trimValues: true });
  const doc = parser.parse(xml) as ParsedRss;
  const channel = doc.feed ?? doc.rss?.channel;
  const entries = toArray(channel?.item);
  const videos: ParsedVideo[] = [];
  for (const e of entries) {
    const v = rssToVideo(e);
    if (v) videos.push(v);
  }
  return {
    name: channel?.['itunes:author'] ?? channel?.title ?? null,
    avatarUrl: pickThumb(channel?.['itunes:image']),
    videos,
    htmlForMeta: xml,
  };
}

function extractAvatarFromHtml(html: string): string | null {
  const m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  if (m) return m[1];
  const m2 = html.match(/<link[^>]+rel=["']apple-touch-icon["'][^>]+href=["']([^"']+)["']/i);
  if (m2) return m2[1];
  return null;
}

function extractNameFromHtml(html: string, fallback: string): string {
  const m = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (m) return m[1];
  return fallback;
}

async function resolveByUrl(url: string, signal?: AbortSignal): Promise<ResolvedChannel | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/odysee\.com$/i.test(parsed.hostname.replace(/^www\./, ''))) return null;
  const segs = parsed.pathname.split('/').filter(Boolean);
  const first = segs[0] ?? '';
  if (!first.startsWith('@')) return null;
  const channelRef = first.slice(1);
  return await resolveByHandle(channelRef, signal);
}

async function resolveByHandle(raw: string, signal?: AbortSignal): Promise<ResolvedChannel | null> {
  const clean = raw.replace(/^@/, '');
  if (!HANDLE_RE.test(`@${clean}`) && !CLAIM_ID_RE.test(clean)) return null;
  const rssRef = `@${clean}`;
  try {
    const { name, avatarUrl, htmlForMeta } = await rssFetch(rssRef, signal);
    const id = CLAIM_ID_RE.test(clean) ? clean : extractClaimIdFromFeed(htmlForMeta) ?? clean;
    const channelUrl = `https://odysee.com/${rssRef}`;
    let finalName = name;
    let finalAvatar = avatarUrl;
    if ((!finalName || !finalAvatar) && id) {
      try {
        const html = await fetchText(channelUrl, signal);
        finalName = finalName ?? extractNameFromHtml(html, clean);
        finalAvatar = finalAvatar ?? extractAvatarFromHtml(html);
      } catch {
        /* keep prior */
      }
    }
    return {
      id,
      name: finalName ?? clean,
      avatarUrl: finalAvatar,
      urlSlug: rssRef,
    };
  } catch (e) {
    throw e;
  }
}

function extractClaimIdFromFeed(xml: string): string | null {
  const m = xml.match(/<link>https?:\/\/odysee\.com\/[^<]*:([a-f0-9]{40})<\/link>/);
  return m ? m[1] : null;
}

async function resolveByClaimId(claimId: string, signal?: AbortSignal): Promise<ResolvedChannel | null> {
  if (!CLAIM_ID_RE.test(claimId)) return null;
  try {
    const html = await fetchText(`https://odysee.com/${claimId}`, signal);
    const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
    const ogImage = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
    return {
      id: claimId,
      name: ogTitle?.[1] ?? claimId,
      avatarUrl: ogImage?.[1] ?? null,
    };
  } catch {
    return null;
  }
}

export const odyseeAdapter: SourceAdapter = {
  kind: 'odysee',
  watchUrl(videoId) {
    return `https://odysee.com/${videoId}`;
  },
  channelUrl(id) {
    return `https://odysee.com/${id}`;
  },
  videoIdForStorage(raw) {
    return raw;
  },
  videoIdFromStorage(stored) {
    return stored;
  },
  detectInput(raw) {
    const input = raw.trim();
    if (input.length === 0) return false;
    if (URL_RE.test(input)) return true;
    if (CLAIM_ID_RE.test(input)) return true;
    if (HANDLE_RE.test(input)) return true;
    return false;
  },
  async resolveChannel(rawInput, signal) {
    const input = rawInput.trim();
    if (URL_RE.test(input)) {
      const r = await resolveByUrl(input, signal);
      if (r) return r;
    }
    if (CLAIM_ID_RE.test(input)) {
      const r = await resolveByClaimId(input, signal);
      if (r) return r;
    }
    if (HANDLE_RE.test(input)) {
      const r = await resolveByHandle(input, signal);
      if (r) return r;
    }
    throw new Error('Not a recognizable Odysee channel, handle or URL');
  },
  async fetchChannel(id, signal, hint) {
    const slug = hint?.urlSlug ?? null;
    const ref = slug ?? (id.startsWith('@') ? id : `@${id}`);
    const rss = await rssFetch(ref, signal);
    let videos = rss.videos;
    if (hint?.limit && videos.length > hint.limit) videos = videos.slice(0, hint.limit);
    return {
      videos,
      name: hint?.name ?? rss.name,
      avatarUrl: hint?.avatarUrl ?? rss.avatarUrl,
      kind: 'odysee',
    };
  },
};

registerSource(odyseeAdapter);
