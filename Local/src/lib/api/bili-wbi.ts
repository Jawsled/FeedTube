import { apiFetch } from '../platform';
import { getBiliCookieHeader } from './bili-cookies';
import { getDmImgParams, requireBiliDevice } from './bili-device';
import { sha1Hex } from './bili-hash';

const WBI_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // mixin key is stable for the day (Asia/Shanghai)
export const WWW_REFERER = 'https://www.bilibili.com/';
export const SPACE_REFERER = 'https://space.bilibili.com/';
const ACCEPT_LANGUAGE = 'zh-CN,zh;q=0.9,en;q=0.8';

interface WbiKeys {
  imgKey: string;
  subKey: string;
  fetchedAt: number;
}

function baseNameFromUrl(url: string): string | null {
  const parts = url.split('/');
  const last = parts[parts.length - 1] ?? '';
  const dot = last.lastIndexOf('.');
  return dot > 0 ? last.slice(0, dot) : last;
}

export function wbiMixinKey(imgValue: string, subValue: string): string {
  // Static mixin key table (stable across days per Bilibili's public docs).
  const oe = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];
  const ae = (imgValue + subValue).split('').map((c) => c.charCodeAt(0));
  let le = '';
  for (const idx of oe) le += String.fromCharCode(ae[idx]);
  return le.slice(0, 32);
}

let _wbiKeys: WbiKeys | null = null;
let _inFlight: Promise<WbiKeys> | null = null;

async function fetchAndCacheKeys(signal?: AbortSignal): Promise<WbiKeys> {
  const res = await apiFetch('https://api.bilibili.com/x/web-interface/nav', {
    headers: { 'User-Agent': requireBiliDevice().userAgent, Referer: WWW_REFERER, Accept: 'application/json', 'Accept-Language': ACCEPT_LANGUAGE },
    signal,
  });
  if (!res.ok) throw new Error(`Bilibili nav request failed (HTTP ${res.status})`);
  const text = await res.text();
  let j: { code?: number; message?: string; data?: { wbi_img?: { img_url?: string; sub_url?: string } } };
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error('Bilibili returned an anti-bot/risk-control page instead of JSON while fetching WBI keys');
  }
  // Anonymous users get code -101 ("账号未登录") but the response still carries usable wbi_img keys.
  const img = j?.data?.wbi_img;
  if (!img?.img_url || !img?.sub_url) {
    throw new Error(`Bilibili WBI keys unavailable (code ${j?.code ?? '?'}: ${j?.message ?? 'no wbi_img in nav response'})`);
  }
  const imgKey = baseNameFromUrl(img.img_url);
  const subKey = baseNameFromUrl(img.sub_url);
  if (!imgKey || !subKey) throw new Error('Bilibili WBI keys unavailable (could not parse wbi_img URLs)');
  return { imgKey, subKey, fetchedAt: Date.now() };
}

export function getWbiKeys(signal?: AbortSignal): Promise<WbiKeys> {
  if (_wbiKeys && Date.now() - _wbiKeys.fetchedAt < WBI_CACHE_TTL_MS) return Promise.resolve(_wbiKeys);
  if (!_inFlight) {
    _inFlight = fetchAndCacheKeys(signal).then((k) => {
      _wbiKeys = k;
      _inFlight = null;
      return k;
    }).catch((e) => {
      _inFlight = null;
      throw e;
    });
  }
  return _inFlight;
}

export async function buildSignedQuery(params: Record<string, string>, mixinKey: string): Promise<string> {
  // PipePipe signs the exact encoded query string (keys and values percent-encoded);
  // the same string is both hashed and sent, so any consistent encoding works.
  const entries = Object.entries(params).sort(([a], [b]) => a.localeCompare(b));
  const q = entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const arr = sha1Hex(q + mixinKey);
  return `${q}&w_rid=${arr}`;
}

export interface SignedFetchOptions {
  referer?: string;
}

/** Detects Bilibili risk-control / anti-bot rejections so callers can skip retries
 *  and back off the WBI endpoint when the IP/UA has been rate-limited. */
export function isRiskBan(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  if (/Bilibili API error (-352|-412|-799)\b/.test(m)) return true;
  if (/Bilibili (?:request|app API) failed \(HTTP (401|402|403|418|429)\)/.test(m)) return true;
  if (/Bilibili (WBI keys|nav request) failed \(HTTP 4\d\d\)/.test(m)) return true;
  if (/Failed to fetch|Failed to execute .fetch./i.test(m)) return true;
  if (/anti-bot|risk-control/i.test(m)) return true;
  return false;
}

export async function signedFetchJson<T>(
  url: string,
  params: Record<string, string>,
  opts?: SignedFetchOptions,
  signal?: AbortSignal,
): Promise<T> {
  const keys = await getWbiKeys(signal);
  const device = requireBiliDevice();
  const cookieHeader = await getBiliCookieHeader(signal);
  const wts = Math.floor(Date.now() / 1000);
  // Device fingerprint params are required by Bilibili risk control on WBI endpoints.
  const allParams: Record<string, string> = { ...params, ...getDmImgParams(device), wts: String(wts) };
  const mixin = wbiMixinKey(keys.imgKey, keys.subKey);
  const q = await buildSignedQuery(allParams, mixin);
  const finalUrl = `${url}?${q}`;
  const res = await apiFetch(finalUrl, {
    headers: {
      'User-Agent': device.userAgent,
      Referer: opts?.referer ?? WWW_REFERER,
      Accept: 'application/json',
      'Accept-Language': ACCEPT_LANGUAGE,
      Cookie: cookieHeader,
    },
    signal,
  });
  if (!res.ok) throw new Error(`Bilibili request failed (HTTP ${res.status})`);
  const text = await res.text();
  let j: { code?: number; message?: string; data?: T };
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error('Bilibili returned an anti-bot/risk-control page instead of JSON');
  }
  if (!j || typeof j.code !== 'number' || j.code !== 0) {
    const code = j && typeof j.code === 'number' ? j.code : '?';
    const msg = j && typeof j.message === 'string' ? j.message : '';
    throw new Error(`Bilibili API error ${code}${msg ? `: ${msg}` : ''}`);
  }
  return j.data as T;
}
