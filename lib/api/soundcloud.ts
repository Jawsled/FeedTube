import type { ParsedVideo } from '../types';
import { registerSource, type ResolvedChannel, type SourceAdapter, type SourceFetchResult } from './source';
import { browser } from 'wxt/browser';

// SoundCloud v2 API approach (same as the Grayjay SoundCloud plugin).
// The old `feeds.soundcloud.com/usersoundcloud:<handle>/sounds.rss`
// endpoint was disabled by SoundCloud in 2024. Instead, we use the
// v2 web API at `api-v2.soundcloud.com`, which is the same one the
// SoundCloud web app uses internally. It requires a `client_id` and
// `app_version` query parameter. We bootstrap these by scraping the
// SoundCloud mobile discovery page (`m.soundcloud.com/discover`),
// which is publicly accessible and includes the values inline in its
// hydration JSON (same approach as the Grayjay SoundCloud plugin).
// The values rotate every few days, so we cache them in memory for 1 hour.

const API_URL = 'https://api-v2.soundcloud.com';
const MOBILE_DISCOVER_URL = 'https://m.soundcloud.com/discover';
const DESKTOP_DISCOVER_URL = 'https://soundcloud.com/discover';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour — SoundCloud can rotate
// client_id/app_version, and stale creds get rejected with 401. Refresh
// aggressively so a bad creds cache doesn't brick all SoundCloud
// channels.
const CRED_PATH_KEY = 'credsPathAttemptedAt';
const PAGE_LIMIT = 30;
const MAX_PAGES = 4;

// SoundCloud stores user data in two forms:
//   - permalink: a URL slug like "slayyyter" (used in soundcloud.com/<slug>)
//   - numeric id: an internal integer like 914653456
// Our channel records should be keyed by the permalink (it's stable, the
// id can change if SoundCloud migrates data). When we get a numeric id
// (e.g. from a Grayjay export), we re-resolve it through the v2 API
// (`/users/{id}`) to find the permalink, then store that.
//
// A "handle" is whatever goes after `soundcloud.com/` in the user URL —
// an alphanumeric slug, not the internal id. The v2 /resolve endpoint
// only works with real permalinks; if you pass it a URL with a numeric
// path (e.g. `/914653456`), it returns 404.

const URL_RE = /^https?:\/\/(?:www\.|m\.)?soundcloud\.com\/[A-Za-z0-9._-]{1,80}(?:\/|$|\?)/i;
const SHORT_URL_RE = /^https?:\/\/on\.soundcloud\.com\/[A-Za-z0-9._-]+/i;
// Accepts plain permalinks ("slayyyter") but rejects pure-numeric
// strings (the internal user id). We use a separate code path for those.
const PERMALINK_RE = /^[A-Za-z0-9._-]{1,80}$/;
const NUMERIC_ID_RE = /^\d{1,20}$/;
const HANDLE_INVALID_RE = /^(@?bilibili|@?youtube|@?odysee|@?peertube)$/i;

interface ScCredentials {
  clientId: string;
  appVersion: string;
}

let credsCache: { value: ScCredentials; fetchedAt: number } | null = null;
let credsPromise: Promise<ScCredentials> | null = null;

function normalizeHandle(raw: string): string {
  return raw.trim().replace(/^@/, '').toLowerCase();
}

let offscreenCreated = false;

async function ensureOffscreen(): Promise<void> {
  if (offscreenCreated) return;
  try {
    await (browser as any).offscreen.createDocument({
      url: browser.runtime.getURL('/offscreen.html' as any),
      reasons: [(browser as any).offscreen.Reason.BLOBS],
      justification: 'SoundCloud API requests require page context to bypass DataDome',
    });
    offscreenCreated = true;
  } catch {
    // Already exists or unsupported.
    offscreenCreated = true;
  }
}

async function offscreenFetch(type: 'sc-fetch-text' | 'sc-fetch-json', url: string): Promise<{ ok: boolean; status: number; text: string }> {
  await ensureOffscreen();
  try {
    const result = await browser.runtime.sendMessage({ type, url });
    if (!result) {
      console.error(`[SC] offscreen returned null for ${type} ${url}`);
      return { ok: false, status: 0, text: 'offscreen returned null' };
    }
    return result;
  } catch (e) {
    console.error(`[SC] offscreensendMessage error for ${type} ${url}:`, e);
    return { ok: false, status: 0, text: e instanceof Error ? e.message : String(e) };
  }
}

async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  const res = await offscreenFetch('sc-fetch-text', url);
  console.log(`[SC] fetchText ${url} -> status=${res.status} ok=${res.ok} len=${res.text?.length}`);
  if (!res.ok) throw new Error(`SoundCloud HTTP ${res.status} from ${url}`);
  return res.text;
}

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await offscreenFetch('sc-fetch-json', url);
  console.log(`[SC] fetchJson ${url} -> status=${res.status} ok=${res.ok} len=${res.text?.length}`);
  if (res.status === 401) {
    // Stale or revoked client_id. Drop the cache and re-bootstrap.
    credsCache = null;
  }
  if (!res.ok) throw new Error(`SoundCloud HTTP ${res.status} from ${url}`);
  return JSON.parse(res.text) as T;
}

async function bootstrapCredentials(signal?: AbortSignal): Promise<ScCredentials> {
  if (credsCache && Date.now() - credsCache.fetchedAt < CACHE_TTL_MS) {
    return credsCache.value;
  }
  if (credsPromise) return credsPromise;
  credsPromise = (async () => {
    // Primary: fetch the mobile discover page (same as Grayjay plugin).
    // The page contains clientId and buildVersion inline in hydration JSON.
    try {
      const html = await fetchText(MOBILE_DISCOVER_URL, signal);
      const clientIdMatch = html.match(/"clientId":"([a-zA-Z0-9-_]+)"/);
      const versionMatch = html.match(/"buildVersion":"([0-9]+)"/);
      if (clientIdMatch && versionMatch) {
        const value = { clientId: clientIdMatch[1], appVersion: versionMatch[1] };
        credsCache = { value, fetchedAt: Date.now() };
        return value;
      }
    } catch {
      // Mobile page failed — fall through to desktop fallback.
    }

    // Fallback: fetch the desktop discover page for __sc_version and
    // extract client_id from JS bundles.
    const html = await fetchText(DESKTOP_DISCOVER_URL, signal);

    const versionMatch = html.match(/window\.__sc_version\s*=\s*"(\d+)"/);
    if (!versionMatch) {
      throw new Error('Could not extract SoundCloud app_version from discover page');
    }
    const appVersion = versionMatch[1];

    const bundleUrlRe = /src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g;
    const bundleUrls: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = bundleUrlRe.exec(html)) !== null) {
      bundleUrls.push(m[1]);
    }
    if (bundleUrls.length === 0) {
      throw new Error('Could not find any SoundCloud JS bundles on discover page');
    }

    const clientIdRe = /client_id["\x27]?\s*[:=]\s*["\x27]([a-zA-Z0-9_-]+)["\x27]/;
    const candidates = bundleUrls.slice(-5);
    let clientId: string | null = null;
    for (const url of candidates) {
      if (signal?.aborted) break;
      try {
        const js = await fetchText(url, signal);
        const match = js.match(clientIdRe);
        if (match) {
          clientId = match[1];
          break;
        }
      } catch {
        // Continue to next bundle if this one fails to load.
      }
    }
    if (!clientId) {
      throw new Error('Could not extract SoundCloud client_id from JS bundles');
    }

    const value = { clientId, appVersion };
    credsCache = { value, fetchedAt: Date.now() };
    return value;
  })();
  try {
    return await credsPromise;
  } finally {
    credsPromise = null;
  }
}

function withCreds(url: string, creds: ScCredentials): string {
  const u = new URL(url);
  u.searchParams.set('client_id', creds.clientId);
  u.searchParams.set('app_version', creds.appVersion);
  u.searchParams.set('app_locale', 'en');
  u.searchParams.set('linked_partitioning', '1');
  return u.toString();
}

interface ScUser {
  id: number;
  username: string;
  permalink: string;
  permalink_url: string;
  full_name?: string;
  description?: string;
  avatar_url?: string;
  followers_count?: number;
  track_count?: number;
}

interface ScCollection<T> {
  collection: T[];
  next_href: string | null;
}

interface ScTrack {
  id: number;
  title: string;
  permalink_url: string;
  artwork_url?: string | null;
  duration: number;
  created_at: string;
  playback_count?: number | null;
  likes_count?: number | null;
  user: { id: number; username: string; permalink_url: string };
  permalink: string;
}

function upgradeArtwork(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.replace(/-(?:large|small|mini|badge|t\d+x\d+|crop)(?=\.[a-z]+$)/i, '-t500x500');
}

function trackToVideo(t: ScTrack): ParsedVideo {
  return {
    id: `sc:${t.id}`,
    title: (t.title ?? '').trim() || 'Untitled',
    publishedAt: t.created_at ? Date.parse(t.created_at) : null,
    approxDate: false,
    durationSeconds: typeof t.duration === 'number' && t.duration > 0 ? Math.round(t.duration / 1000) : null,
    viewCount: typeof t.playback_count === 'number' ? t.playback_count : null,
    kind: 'video',
    thumbnailUrl: upgradeArtwork(t.artwork_url),
  };
}

/**
 * Resolve a user by either a permalink ("slayyyter") or a numeric id
 * ("914653456"). Uses `/resolve?url=` for permalinks and `/users/{id}`
 * for numeric ids. The two endpoints are both public.
 *
 * If the request fails with 401 (stale creds), invalidate the cache and
 * retry once with freshly bootstrapped credentials.
 */
async function fetchUser(
  handleOrId: string,
  creds: ScCredentials,
  signal?: AbortSignal,
): Promise<ScUser | null> {
  const cleaned = handleOrId.replace(/^@/, '');
  const tryOnce = async (credsToUse: ScCredentials): Promise<ScUser | null> => {
    if (NUMERIC_ID_RE.test(cleaned)) {
      const url = withCreds(`${API_URL}/users/${cleaned}`, credsToUse);
      try {
        return await fetchJson<ScUser>(url, signal);
      } catch {
        return null;
      }
    }
    try {
      const resolveUrl = withCreds(
        `${API_URL}/resolve?url=${encodeURIComponent(`https://soundcloud.com/${cleaned.toLowerCase()}`)}`,
        credsToUse,
      );
      return await fetchJson<ScUser>(resolveUrl, signal);
    } catch {
      try {
        const html = await fetchText(`https://soundcloud.com/${cleaned.toLowerCase()}`, signal);
        const m = html.match(/window\.__sc_hydration\s*=\s*(\[.+?\]);/);
        if (!m) return null;
        const data = JSON.parse(m[1]) as Array<{ hydratable?: string; data?: ScUser }>;
        const userHydration = data.find((h) => h.hydratable === 'user');
        return userHydration?.data ?? null;
      } catch {
        return null;
      }
    }
  };
  const result = await tryOnce(creds);
  if (result) return result;
  // If the first attempt failed, bootstrap fresh creds and try again.
  credsCache = null;
  const freshCreds = await bootstrapCredentials(signal);
  return await tryOnce(freshCreds);
}

async function fetchAllUserTracks(
  userId: number,
  creds: ScCredentials,
  signal?: AbortSignal,
): Promise<ScTrack[]> {
  const all: ScTrack[] = [];
  let nextHref: string | null = withCreds(
    `${API_URL}/users/${userId.toString()}/tracks?limit=${PAGE_LIMIT}&offset=0`,
    creds,
  );
  for (let page = 0; page < MAX_PAGES && nextHref; page++) {
    if (signal?.aborted) break;
    const res: ScCollection<ScTrack> = await fetchJson<ScCollection<ScTrack>>(nextHref, signal);
    for (const t of res.collection) all.push(t);
    nextHref = res.next_href ? withCreds(res.next_href, creds) : null;
  }
  return all;
}

async function resolveByUrl(url: string, signal?: AbortSignal): Promise<ResolvedChannel | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'soundcloud.com') {
    const segs = parsed.pathname.split('/').filter(Boolean);
    const first = segs[0];
    if (!first || first === 'you' || first === 'discover' || first === 'stream') return null;
    const handle = first.toLowerCase();
    if (!PERMALINK_RE.test(handle)) return null;
    return await resolveByHandle(handle, signal);
  }
  if (host === 'on.soundcloud.com') {
    try {
      const res = await offscreenFetch('sc-fetch-text', url);
      const finalUrl = res.text || url;
      return await resolveByUrl(finalUrl, signal);
    } catch {
      return null;
    }
  }
  return null;
}

async function resolveByHandle(handle: string, signal?: AbortSignal): Promise<ResolvedChannel | null> {
  // Accept either a permalink ("slayyyter") or a numeric user id
  // ("914653456") — Grayjay exports the latter.
  const cleaned = handle.replace(/^@/, '').toLowerCase();
  if (HANDLE_INVALID_RE.test(cleaned)) return null;
  if (!PERMALINK_RE.test(cleaned) && !NUMERIC_ID_RE.test(cleaned)) return null;
  // oEmbed only works with real permalinks, so for numeric ids we
  // skip it. The v2 API gives us everything we need.
  let oembed: { author_name?: string; thumbnail_url?: string } | null = null;
  if (PERMALINK_RE.test(cleaned)) {
    try {
      const url = `https://soundcloud.com/oembed?url=${encodeURIComponent(
        `https://soundcloud.com/${cleaned}`,
      )}&format=json`;
      oembed = await fetchJson(url, signal);
    } catch {
      oembed = null;
    }
  }
  let name: string | null = oembed?.author_name ?? cleaned;
  let avatarUrl: string | null = oembed?.thumbnail_url ?? null;
  let permalink: string | null = null;
  try {
    const creds = await bootstrapCredentials(signal);
    const user = await fetchUser(cleaned, creds, signal);
    if (user) {
      permalink = user.permalink;
      if (user.full_name) name = user.full_name;
      if (user.avatar_url) avatarUrl = user.avatar_url;
    }
  } catch {
    // oEmbed data is still useful for the displayed name/avatar.
  }
  // Always store the resolved permalink as the channel id (not the
  // numeric one) so subsequent fetches can use it directly.
  if (!permalink) return null;
  return {
    id: `sc_${permalink}`,
    name,
    avatarUrl,
    urlSlug: permalink,
  };
}

export const soundcloudAdapter: SourceAdapter = {
  kind: 'soundcloud',
  watchUrl(videoId) {
    if (videoId.startsWith('soundcloud:')) return videoId.slice('soundcloud:'.length);
    if (videoId.startsWith('sc_track:')) return videoId.slice('sc_track:'.length);
    if (videoId.startsWith('sc:')) return `https://soundcloud.com/track/${videoId.slice(3)}`;
    return videoId;
  },
  channelUrl(id) {
    const handle = id.startsWith('sc_') ? id.slice(3) : id;
    return `https://soundcloud.com/${handle}`;
  },
  videoIdForStorage(rawId) {
    return rawId;
  },
  videoIdFromStorage(stored) {
    if (stored.startsWith('soundcloud:')) return stored.slice('soundcloud:'.length);
    return stored;
  },
  detectInput(rawInput) {
    const t = rawInput.trim();
    if (t.length === 0) return false;
    if (URL_RE.test(t) || SHORT_URL_RE.test(t)) return true;
    if (t.startsWith('@')) {
      const rest = t.slice(1);
      return PERMALINK_RE.test(rest) && !HANDLE_INVALID_RE.test(rest);
    }
    return false;
  },
  async resolveChannel(rawInput, signal) {
    const t = rawInput.trim();
    if (URL_RE.test(t) || SHORT_URL_RE.test(t)) {
      const r = await resolveByUrl(t, signal);
      if (r) return r;
    }
    if (t.startsWith('@')) {
      const r = await resolveByHandle(t, signal);
      if (r) return r;
    }
    throw new Error('Not a recognizable SoundCloud handle or URL');
  },
  async fetchChannel(id, signal, hint): Promise<SourceFetchResult> {
    // `urlSlug` carries the resolved permalink. Fall back to stripping
    // `sc_` from the id, but only if what remains is a real permalink
    // (not a numeric id from a Grayjay import — for that, the
    // user needs to re-resolve via the Add subscription flow).
    const fromSlug = hint?.urlSlug && hint.urlSlug.length > 0 ? hint.urlSlug : null;
    const stripped = id.startsWith('sc_') ? id.slice(3) : id;
    const handle = fromSlug ?? (PERMALINK_RE.test(stripped) ? stripped : null);
    if (!handle) {
      throw new Error(
        `SoundCloud channel has a stale numeric id (${id}). Remove and re-add it from soundcloud.com/<handle> so the permalink is captured.`,
      );
    }
    const creds = await bootstrapCredentials(signal);
    const user = await fetchUser(handle, creds, signal);
    if (!user) {
      throw new Error(`SoundCloud user not found: ${handle}`);
    }
    const tracks = await fetchAllUserTracks(user.id, creds, signal);
    let videos = tracks.map(trackToVideo);
    if (hint?.limit && videos.length > hint.limit) videos = videos.slice(0, hint.limit);
    return {
      videos,
      name: hint?.name ?? user.full_name ?? user.username,
      avatarUrl: hint?.avatarUrl ?? user.avatar_url ?? null,
      kind: 'soundcloud',
      backendDetail: 'v2-api',
    };
  },
};

registerSource(soundcloudAdapter);
