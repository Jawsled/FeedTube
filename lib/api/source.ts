import type { ParsedVideo, VideoKind } from '../types';

export const ALL_SOURCE_KINDS = ['youtube', 'odysee', 'bilibili', 'peertube', 'soundcloud'] as const;
export type SourceKind = (typeof ALL_SOURCE_KINDS)[number];

export interface SourceMeta {
  kind: SourceKind;
  label: string;
  shortLabel: string;
  color: string;
  /** Inline SVG markup for the platform logo. */
  icon: string;
}

const YT_ICON =
  '<svg viewBox="0 0 24 24" width="12" height="12" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M21.6 7.2a2.5 2.5 0 0 0-1.8-1.8C18.3 5 12 5 12 5s-6.3 0-7.8.4A2.5 2.5 0 0 0 2.4 7.2 26 26 0 0 0 2 12a26 26 0 0 0 .4 4.8 2.5 2.5 0 0 0 1.8 1.8C5.7 19 12 19 12 19s6.3 0 7.8-.4a2.5 2.5 0 0 0 1.8-1.8A26 26 0 0 0 22 12a26 26 0 0 0-.4-4.8zM10 15V9l5.2 3-5.2 3z"/></svg>';

const ODYSEE_ICON =
  '<svg viewBox="0 0 24 24" width="12" height="12" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M7 12a5 5 0 0 1 10 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/></svg>';

const BILIBILI_ICON =
  '<svg viewBox="0 0 24 24" width="12" height="12" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="6" width="18" height="13" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M7 4l3 2M17 4l-3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="9" cy="13" r="1" fill="currentColor"/><circle cx="15" cy="13" r="1" fill="currentColor"/></svg>';

const PEERTUBE_ICON =
  '<svg viewBox="0 0 24 24" width="12" height="12" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9 8h4a3 3 0 0 1 0 6H9z" fill="currentColor"/></svg>';

const SOUNDCLOUD_ICON =
  '<svg viewBox="0 0 24 24" width="12" height="12" xmlns="http://www.w3.org/2000/svg"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M3 14v-2M6 16V8M9 18V6M12 17V9M15 16V10M18 15v-3M21 14a4 4 0 0 0-4-4"/></svg>';

export const SOURCE_META: Record<SourceKind, SourceMeta> = {
  youtube: { kind: 'youtube', label: 'YouTube', shortLabel: 'YT', color: '#f0484a', icon: YT_ICON },
  odysee: { kind: 'odysee', label: 'Odysee', shortLabel: 'ODY', color: '#ef9b2b', icon: ODYSEE_ICON },
  bilibili: { kind: 'bilibili', label: 'Bilibili', shortLabel: 'BILI', color: '#00aeec', icon: BILIBILI_ICON },
  peertube: { kind: 'peertube', label: 'PeerTube', shortLabel: 'PT', color: '#f1680d', icon: PEERTUBE_ICON },
  soundcloud: { kind: 'soundcloud', label: 'SoundCloud', shortLabel: 'SC', color: '#ff5500', icon: SOUNDCLOUD_ICON },
};

export interface ResolvedChannel {
  id: string;
  name: string | null;
  avatarUrl: string | null;
  urlSlug?: string | null;
}

export interface SourceFetchResult {
  videos: ParsedVideo[];
  name: string | null;
  avatarUrl: string | null;
  kind: SourceKind;
  backendDetail?: string;
}

export interface SourceAdapter {
  kind: SourceKind;
  watchUrl(videoId: string, kind: VideoKind): string;
  channelUrl(id: string): string;
  resolveChannel(rawInput: string, signal?: AbortSignal): Promise<ResolvedChannel>;
  fetchChannel(
    id: string,
    signal?: AbortSignal,
    hint?: { name?: string | null; avatarUrl?: string | null; urlSlug?: string | null; limit?: number },
  ): Promise<SourceFetchResult>;
  detectInput(rawInput: string): boolean;
  videoIdForStorage(rawId: string): string;
  videoIdFromStorage(stored: string): string;
}

const adapters: Partial<Record<SourceKind, SourceAdapter>> = {};

export function registerSource(adapter: SourceAdapter): void {
  adapters[adapter.kind] = adapter;
}

export function getSource(kind: SourceKind): SourceAdapter {
  const a = adapters[kind];
  if (!a) throw new Error(`Source adapter not registered: ${kind}`);
  return a;
}

export function detectSource(rawInput: string): SourceKind | null {
  const input = rawInput.trim();
  if (input.length === 0) return null;
  // Detection order matters: YouTube's "anything that looks like a handle/id"
  // detection would otherwise steal inputs meant for other platforms.
  // Bilibili is checked first (for bare numeric mids), then Odysee, then
  // YouTube, then the more specific URL-based detectors for PeerTube/SoundCloud.
  const order: SourceKind[] = ['bilibili', 'odysee', 'youtube', 'peertube', 'soundcloud'];
  for (const k of order) {
    const a = adapters[k];
    if (a?.detectInput(input)) return k;
  }
  return null;
}

export function listSourceKinds(): SourceKind[] {
  return [...ALL_SOURCE_KINDS];
}
