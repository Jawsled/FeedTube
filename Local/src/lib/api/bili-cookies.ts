import { apiFetch } from '../platform';
import { browser } from '../platform';
import { requireBiliDevice } from './bili-device';

// Anonymous cookie bootstrap, modeled on PipePipe's BilibiliService.getCookie():
// buvid3/4 -> spi ticket (buvid_fp + b_lsid) -> bili_ticket. All values are random
// and do not require a login; they exist to pass basic risk checks.

let _cached: string | null = null;
let _inFlight: Promise<string> | null = null;

const BANNED_KEY = 'biliWebBannedUntil';
const BANNED_TTL_MS = 30 * 60 * 1000;

export function invalidateBiliCookies(): void {
  _cached = null;
}

export async function getBiliBannedUntil(): Promise<number | null> {
  try {
    const obj = await browser.storage.local.get(BANNED_KEY);
    const v = obj[BANNED_KEY];
    if (typeof v === 'number' && v > Date.now()) return v;
    return null;
  } catch {
    return null;
  }
}

export async function setBiliBannedUntil(until: number): Promise<void> {
  try {
    await browser.storage.local.set({ [BANNED_KEY]: until });
  } catch {
    /* best-effort */
  }
}

export async function clearBiliBannedUntil(): Promise<void> {
  try {
    await browser.storage.local.remove(BANNED_KEY);
  } catch {
    /* best-effort */
  }
}

function randHex(len: number): string {
  const bytes = new Uint8Array(Math.ceil(len / 2));
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out.slice(0, len);
}

async function bootstrapCookies(signal?: AbortSignal): Promise<string> {
  const ua = requireBiliDevice().userAgent;
  const buvid3 = `DEF${randHex(32)}`;
  const buvid4 = randHex(32);
  let biliTicket = '';

  try {
    const res = await apiFetch(`https://api.bilibili.com/x/frontend/common/v1?w_rid=${crypto.randomUUID()}`, {
      headers: { 'User-Agent': ua, Referer: 'https://www.bilibili.com/' },
      signal,
    });
    if (res.ok) biliTicket = res.headers.get('buvid_fp') ?? '';
  } catch {
    /* optional */
  }

  try {
    const res2 = await apiFetch(
      `https://api.bilibili.com/x/internal/v2/cookie?b_nif=${encodeURIComponent(buvid4)}&b_lid=${biliTicket}&buvid=${buvid3}`,
      { headers: { 'User-Agent': ua, Referer: 'https://www.bilibili.com/' }, signal },
    );
    if (res2.ok) biliTicket = res2.headers.get('bili_ticket') ?? biliTicket;
  } catch {
    /* optional */
  }

  return `buvid3=${buvid3}; buvid4=${buvid4}${biliTicket ? `; b_lsid=${biliTicket}` : ''}`;
}

export function getBiliCookieHeader(signal?: AbortSignal): Promise<string> {
  if (_cached) return Promise.resolve(_cached);
  if (!_inFlight) {
    _inFlight = bootstrapCookies(signal).then((c) => {
      _cached = c;
      _inFlight = null;
      return c;
    }).catch((e) => {
      _inFlight = null;
      throw new Error(`Failed to generate Bilibili cookies: ${e instanceof Error ? e.message : String(e)}`);
    });
  }
  return _inFlight;
}
