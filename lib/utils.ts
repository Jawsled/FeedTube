export function deepCollect(obj: unknown, key: string, out: unknown[] = [], depth = 0): unknown[] {
  if (obj == null || typeof obj !== 'object' || depth > 40) return out;
  if (Array.isArray(obj)) {
    for (const v of obj) deepCollect(v, key, out, depth + 1);
    return out;
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (k === key) out.push(v);
    deepCollect(v, key, out, depth + 1);
  }
  return out;
}

export function deepGet(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const p of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

const UNIT_MS: Record<string, number> = {
  second: 1000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 2_629_746_000,
  year: 31_556_952_000,
};

export function relativeToEpoch(text: string | null | undefined, now = Date.now()): number | null {
  if (!text) return null;
  const m = /(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i.exec(text);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const ms = UNIT_MS[unit];
  if (!Number.isFinite(n) || !ms) return null;
  return now - n * ms;
}

export function parseCount(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = /([\d.,]+)\s*([KMB])?/i.exec(text.replace(/[\u00a0\s]/g, ''));
  if (!m) return null;
  let numStr = m[1];
  if (/^\d{1,3}(\.\d{3})+$/.test(numStr)) numStr = numStr.replace(/\./g, '');
  else numStr = numStr.replace(/,/g, '');
  const num = parseFloat(numStr);
  if (!Number.isFinite(num)) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[m[2]?.toLowerCase() ?? ''] ?? 1;
  return Math.round(num * mult);
}

export function hmsToSeconds(text: string | null | undefined): number | null {
  if (!text) return null;
  const parts = text.trim().split(':').map(Number);
  if (parts.some((p) => Number.isNaN(p)) || parts.length === 0 || parts.length > 3) return null;
  let s = 0;
  for (const p of parts) s = s * 60 + p;
  return s > 0 ? s : null;
}

export function formatRelative(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return '';
  const diff = Math.max(0, now - ts);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30.44);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(days / 365.25)}y ago`;
}

export function formatDuration(sec: number | null | undefined): string {
  if (sec == null || sec <= 0) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

export function formatViews(n: number | null | undefined): string {
  if (n == null) return '';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1).replace(/\.0$/, '')}B views`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M views`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}K views`;
  return `${n} views`;
}

export function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export function channelUrl(channelId: string): string {
  return `https://www.youtube.com/channel/${channelId}`;
}

import type { SourceKind, VideoKind } from './types';
import './api/sources';
import { getSource } from './api/source';

export function sourceWatchUrl(source: SourceKind, videoId: string, kind: VideoKind): string {
  return getSource(source).watchUrl(videoId, kind);
}

export function sourceChannelUrl(source: SourceKind, id: string): string {
  return getSource(source).channelUrl(id);
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

export function uniq<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}
