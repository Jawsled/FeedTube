import SparkMD5 from 'spark-md5';
import type { ParsedVideo, VideoKind } from '../types';
import { registerSource, type ResolvedChannel, type SourceAdapter, type SourceFetchResult } from './source';
import { isRiskBan, signedFetchJson, SPACE_REFERER } from './bili-wbi';
import { clearBiliBannedUntil, getBiliBannedUntil, invalidateBiliCookies, setBiliBannedUntil } from './bili-cookies';
import { regenerateBiliDevice, requireBiliDevice } from './bili-device';

const ACCEPT_LANGUAGE = 'zh-CN,zh;q=0.9,en;q=0.8';
// Public app API credentials (same as PipePipe); only used for the anonymous fallback endpoint.
const APP_KEY = '1d8b6e7d45233436';
const APP_SECRET = '560c52ccd288fed045859ed18bffd973';
// After a risk-ban, skip the (web) WBI endpoint for this long to avoid further bans.
const BILI_BAN_COOLDOWN_MS = 30 * 60 * 1000;
// Short cooldown applied as soon as web is rate-limited (so the queue isn't blocked
// by the same ban being re-discovered for every bilibili channel every refresh).
const BILI_WEB_BAN_COOLDOWN_MS = 5 * 60 * 1000;

/** Any active channel; used by the settings "Test Bilibili API" probe. */
export const BILIBILI_TEST_MID = '946974';

/** Thrown when the global Bilibili WBI cooldown is active (see getBiliBannedUntil). */
export class BiliSkippedError extends Error {
  constructor(public readonly until: number) {
    super(`Bilibili API rate-limited (backed off until ${new Date(until).toLocaleTimeString()})`);
    this.name = 'BiliSkippedError';
  }
}

function midFromChannelId(id: string): string {
  return id.startsWith('mid_') ? id.slice(4) : id;
}

// SparkMD5 is bundled into the extension so the app API can sign requests without
// relying on crypto.subtle.digest (which has never exposed MD5 in browsers).
function md5Hex(s: string): string {
  return SparkMD5.hash(s);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface WebVlistItem {
  aid?: number | string;
  bvid?: string;
  title?: string;
  comment_count?: number;
  created?: number;
  length?: number;
  pic?: string;
}

function webItemToVideo(it: WebVlistItem): ParsedVideo | null {
  const id = it.bvid ?? (it.aid != null ? `av${String(it.aid)}` : null);
  if (!id) return null;
  const title = (it.title ?? '').trim();
  if (!title) return null;
  const duration = typeof it.length === 'number' && isFinite(it.length) && it.length >= 0 ? Math.round(it.length) : null;
  const views = typeof it.comment_count === 'number' && isFinite(it.comment_count) && it.comment_count > 0 ? it.comment_count : null;
  return {
    id,
    title,
    publishedAt: typeof it.created === 'number' && isFinite(it.created) && it.created > 0 ? it.created * 1000 : null,
    approxDate: false,
    durationSeconds: duration,
    viewCount: views,
    kind: 'video',
    thumbnailUrl: it.pic ?? null,
  };
}

// Primary backend: web WBI arc/search (same endpoint PipePipe uses in "web" mode).
async function fetchViaWeb(mid: string, signal?: AbortSignal, limit?: number): Promise<ParsedVideo[]> {
  const data = await signedFetchJson<{ list?: { vlist?: WebVlistItem[] } }>(
    'https://api.bilibili.com/x/space/wbi/arc/search',
    { mid, order: 'pubdate', web_location: '333.1387', ps: String(limit ?? 30) },
    { referer: SPACE_REFERER },
    signal,
  );
  const vlist = data?.list?.vlist ?? [];
  return vlist.map(webItemToVideo).filter((v): v is ParsedVideo => v != null);
}

interface AppApiItem {
  title?: string;
  bvid?: string;
  uri?: string;
  ctime?: number;
  duration?: number;
  cover?: string;
  play?: number;
}

function extractAidFromUri(uri: string | undefined): string | null {
  if (!uri) return null;
  const m = /bilibili:\/\/video\/(\d+)/.exec(uri);
  return m ? `av${m[1]}` : null;
}

function appItemToVideo(it: AppApiItem): ParsedVideo | null {
  const id = it.bvid ?? extractAidFromUri(it.uri);
  if (!id) return null; // non-video entries (courses etc.) have no video id
  const title = (it.title ?? '').trim();
  if (!title) return null;
  const cover = it.cover ? it.cover.replace(/^http:\/\//, 'https://') : null;
  const duration = typeof it.duration === 'number' && isFinite(it.duration) && it.duration >= 0 ? Math.round(it.duration) : null;
  const views = typeof it.play === 'number' && isFinite(it.play) && it.play > 0 ? it.play : null;
  return {
    id,
    title,
    publishedAt: typeof it.ctime === 'number' && isFinite(it.ctime) && it.ctime > 0 ? it.ctime * 1000 : null,
    approxDate: false,
    durationSeconds: duration,
    viewCount: views,
    kind: 'video',
    thumbnailUrl: cover,
  };
}

// Fallback backend: anonymous app API (PipePipe's "client" mode). No WBI keys or cookies needed.
async function fetchViaAppApi(mid: string, signal?: AbortSignal, limit?: number): Promise<ParsedVideo[]> {
  const device = requireBiliDevice();
  const params: Record<string, string> = {
    vmid: mid,
    order: 'pubdate',
    mobi_app: 'android',
    ts: String(Math.floor(Date.now() / 1000)),
    appkey: APP_KEY,
  };
  const sorted = Object.entries(params).sort(([a], [b]) => a.localeCompare(b));
  const qs = sorted.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const sign = md5Hex(`${qs}${APP_SECRET}`);
  const url = `https://app.bilibili.com/x/v2/space/archive/cursor?${qs}&sign=${sign}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': device.userAgent, Referer: SPACE_REFERER, Accept: 'application/json', 'Accept-Language': ACCEPT_LANGUAGE },
    signal,
  });
  if (!res.ok) throw new Error(`Bilibili app API request failed (HTTP ${res.status})`);
  const text = await res.text();
  let j: { code?: number; message?: string; data?: { item?: AppApiItem[] } };
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error('Bilibili app API returned an anti-bot/risk-control page instead of JSON');
  }
  if (!j || typeof j.code !== 'number' || j.code !== 0) {
    const code = j && typeof j.code === 'number' ? j.code : '?';
    const msg = j && typeof j.message === 'string' ? j.message : '';
    throw new Error(`Bilibili app API error ${code}${msg ? `: ${msg}` : ''}`);
  }
  let items = (j.data?.item ?? []).map(appItemToVideo).filter((v): v is ParsedVideo => v != null);
  if (limit && items.length > limit) items = items.slice(0, limit);
  return items;
}

export interface BiliFetchOutcome {
  videos: ParsedVideo[];
  backend: 'bili-web' | 'bili-app';
}

// Web first (with one retry after regenerating device + cookies, like PipePipe), then app API.
// If a web attempt is rate-limited / banned (-352/-412/etc.), skip remaining web retries and
// fall back to the app API. Cooldown semantics:
//   - Web succeeds  → clear the cooldown (the IP/UA is fine again).
//   - Web banned    → set a short (~5 min) cooldown so the next refresh doesn't repeatedly
//     try a known-banned web endpoint, even when the app API is still answering.
//   - Both banned   → set the long ~30-minute cooldown (both endpoints dead).
//
//   { skipWeb: true } skips the web attempt entirely (used on force-refresh when the
//   global cooldown says web is currently banned — saves ~1s of wait for the web fail).
async function runBilibiliFetch(
  mid: string,
  signal?: AbortSignal,
  opts: { skipWeb?: boolean; limit?: number } = {},
): Promise<BiliFetchOutcome> {
  const errors: string[] = [];
  let webBanned = false;
  if (opts.skipWeb) {
    errors.push('skipping web (WBI is in global cooldown) — going straight to app API');
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (opts.skipWeb) break;
    if (attempt > 1 && !webBanned) {
      regenerateBiliDevice();
      invalidateBiliCookies();
      await sleep(1500);
    }
    if (webBanned) break;
    try {
      const videos = await fetchViaWeb(mid, signal, opts.limit);
      await clearBiliBannedUntil();
      return { videos, backend: 'bili-web' };
    } catch (e) {
      if (signal?.aborted) throw e;
      const m = errMsg(e);
      errors.push(`web attempt ${attempt}: ${m}`);
      if (isRiskBan(e)) {
        webBanned = true;
        errors.push('web API rate-limited — skipping remaining web attempts, falling back to app API');
      }
    }
  }
  if (webBanned) {
    // Don't keep hammering a banned web endpoint on every refresh; the app API will still work
    // if we try it again, so a short cooldown is enough to keep the queue flowing for YouTube etc.
    const until = Date.now() + BILI_WEB_BAN_COOLDOWN_MS;
    await setBiliBannedUntil(until);
    errors.push(`backing off WBI endpoint for ${BILI_WEB_BAN_COOLDOWN_MS / 60_000} min (until ${new Date(until).toLocaleTimeString()})`);
  }
  try {
    const videos = await fetchViaAppApi(mid, signal, opts.limit);
    // If the caller told us to skip web, we never tested it — leave the existing cooldown
    // alone (the app API's success doesn't prove the web is now fine).
    if (!webBanned && !opts.skipWeb) await clearBiliBannedUntil();
    return { videos, backend: 'bili-app' };
  } catch (e) {
    if (signal?.aborted) throw e;
    const m = errMsg(e);
    errors.push(`app-api: ${m}`);
    if (isRiskBan(e)) {
      const until = Date.now() + BILI_BAN_COOLDOWN_MS;
      await setBiliBannedUntil(until);
      errors.push(`backing off WBI endpoint for ${BILI_BAN_COOLDOWN_MS / 60_000} min (until ${new Date(until).toLocaleTimeString()})`);
    }
  }
  throw new Error(`Bilibili fetch failed — ${errors.join(' | ')}`);
}

export async function probeBilibiliApi(signal?: AbortSignal): Promise<{ ok: boolean; message: string }> {
  const banned = await getBiliBannedUntil();
  if (banned) {
    return { ok: false, message: `Skipped — Bilibili WBI endpoint is backed off until ${new Date(banned).toLocaleTimeString()}` };
  }
  try {
    const out = await runBilibiliFetch(BILIBILI_TEST_MID, signal);
    return {
      ok: true,
      message: `OK — ${out.videos.length} videos for test channel (mid ${BILIBILI_TEST_MID}) via ${out.backend}`,
    };
  } catch (e) {
    if (signal?.aborted) throw e;
    return { ok: false, message: errMsg(e) };
  }
}

export const bilibiliAdapter: SourceAdapter = {
  kind: 'bilibili',
  watchUrl(id: string, _kind: VideoKind): string {
    const colon = id.indexOf(':');
    const clean = colon >= 0 ? id.slice(colon + 1) : id;
    if (clean.startsWith('BV')) return `https://www.bilibili.com/video/${clean}`;
    return `https://www.bilibili.com/video/av${clean.replace(/^av/, '')}`;
  },
  channelUrl(id: string): string {
    const mid = id.startsWith('mid_') ? id.slice(4) : id;
    return `https://space.bilibili.com/${mid}`;
  },
  async resolveChannel(rawInput: string, signal?: AbortSignal): Promise<ResolvedChannel> {
    let mid: string | null = null;
    const m1 = /bilibili\.com\/([A-Za-z0-9_\-]+)(?:[/?]|$)/.exec(rawInput);
    if (m1) mid = m1[1];
    else if (/^\d+$/.test(rawInput)) mid = rawInput;
    if (!mid || !/^[A-Za-z0-9_]+$/.test(mid)) {
      throw new Error('Unrecognized Bilibili input (expected space.bilibili.com/<id> or a numeric mid)');
    }
    const banned = await getBiliBannedUntil();
    if (banned) {
      throw new BiliSkippedError(banned);
    }
    try {
      const data = await signedFetchJson<{ name?: string; face?: string; url?: string }>(
        'https://api.bilibili.com/x/space/wbi/acc/info',
        { mid, web_location: '1550101' },
        { referer: SPACE_REFERER },
        signal,
      );
      const name = data?.name ?? null;
      const avatarUrl = (data?.face ? `https:${data.face}` : null);
      const urlSlug = data?.url ?? null;
      return { id: `mid_${mid}`, name, avatarUrl, urlSlug };
    } catch (e) {
      if (signal?.aborted) throw e;
      if (e instanceof BiliSkippedError) throw e;
      // Anonymous acc/info can be rate-limited; degrade to a bare channel record.
      console.warn(`bilibili resolveChannel degraded for ${rawInput}:`, e instanceof Error ? e.message : String(e));
      return { id: `mid_${mid}`, name: null, avatarUrl: null };
    }
  },
  async fetchChannel(id: string, signal?: AbortSignal, hint?: { name?: string | null; avatarUrl?: string | null; force?: boolean; limit?: number }): Promise<SourceFetchResult> {
    // On a force-refresh, skip the long "web attempt → discover it's banned → fall back"
    // cycle: if the cooldown says web is dead, go straight to the app API.
    const banned = await getBiliBannedUntil();
    if (banned && !hint?.force) throw new BiliSkippedError(banned);
    const mid = midFromChannelId(id);
    const out = await runBilibiliFetch(mid, signal, { skipWeb: !!banned, limit: hint?.limit });
    return { videos: out.videos, name: hint?.name ?? null, avatarUrl: hint?.avatarUrl ?? null, kind: 'bilibili', backendDetail: out.backend };
  },
  detectInput(rawInput: string): boolean {
    const t = rawInput.trim();
    if (/bilibili\.com\//i.test(t)) return true;
    if (/^\d{1,15}$/.test(t)) return true;
    return false;
  },
  videoIdForStorage(rawId: string): string {
    const bvid = rawId.startsWith('BV') ? rawId : `av${rawId.replace(/^av/, '')}`;
    return `bili_${bvid}`;
  },
  videoIdFromStorage(stored: string): string {
    return stored.replace(/^bili(?:libili)?:?/, '').replace(/^av/, '');
  },
};

registerSource(bilibiliAdapter);
