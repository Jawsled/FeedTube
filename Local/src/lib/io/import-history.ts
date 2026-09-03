import type { SourceKind } from '../types';
import JSZip from 'jszip';

export interface HistoryEntry {
  videoId: string;
  source: SourceKind;
  title: string | null;
  channelName: string | null;
  channelId: string | null;
  watchedAt: number;
  durationSeconds: number | null;
}

export type HistoryFormat =
  | 'freetube-history'
  | 'youtube-history'
  | 'grayjay-history'
  | 'feedtube-history'
  | 'unknown';

interface FreeTubeHistoryEntry {
  videoId?: string;
  title?: string;
  author?: string;
  authorId?: string;
  timeWatched?: number;
  lengthSeconds?: number;
  type?: string;
}

interface YouTubeHistoryEntry {
  header?: string;
  title?: string;
  titleUrl?: string;
  subtitles?: { name?: string; url?: string }[];
  time?: string;
}

export function detectHistoryFormat(file: File, text: string | null): HistoryFormat {
  const name = file.name.toLowerCase();

  if (name.endsWith('.db') || name.endsWith('.sqlite')) {
    if (text && text.trimStart().startsWith('{')) return 'freetube-history';
    return 'unknown';
  }

  if (name.endsWith('.json') && text) {
    try {
      const j = JSON.parse(text);
      if (typeof j === 'object' && j !== null) {
        if (j.app === 'FeedTube' && j.type === 'history') return 'feedtube-history';
        if (Array.isArray(j)) {
          const first = j[0];
          if (first && 'titleUrl' in first && 'subtitles' in first) return 'youtube-history';
        }
      }
    } catch {
      /* not valid JSON */
    }
  }

  return 'unknown';
}

export async function detectHistoryFormatFromFile(file: File): Promise<{ format: HistoryFormat; text: string | null }> {
  const name = file.name.toLowerCase();

  if (name.endsWith('.db') || name.endsWith('.sqlite')) {
    const text = await file.text();
    if (text.trimStart().startsWith('{')) return { format: 'freetube-history', text };
    return { format: 'unknown', text: null };
  }

  if (name.endsWith('.json')) {
    const text = await file.text();
    const format = detectHistoryFormat(file, text);
    return { format, text };
  }

  return { format: 'unknown', text: null };
}

function extractYouTubeVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    return u.searchParams.get('v');
  } catch {
    const m = /[?&]v=([a-zA-Z0-9_-]{11})/.exec(url);
    return m ? m[1] : null;
  }
}

function parseFreeTubeHistory(text: string): HistoryEntry[] {
  const lines = text.split('\n').filter((l) => l.trim());
  const entries: HistoryEntry[] = [];
  for (const line of lines) {
    try {
      const j = JSON.parse(line) as FreeTubeHistoryEntry;
      if (!j.videoId || j.type === 'short') continue;
      entries.push({
        videoId: j.videoId,
        source: 'youtube',
        title: j.title ?? null,
        channelName: j.author ?? null,
        channelId: j.authorId ?? null,
        watchedAt: j.timeWatched ?? Date.now(),
        durationSeconds: j.lengthSeconds ?? null,
      });
    } catch {
      /* skip malformed lines */
    }
  }
  return entries;
}

function parseYouTubeHistory(text: string): HistoryEntry[] {
  const j = JSON.parse(text) as YouTubeHistoryEntry[];
  if (!Array.isArray(j)) return [];
  const entries: HistoryEntry[] = [];
  for (const item of j) {
    if (!item.titleUrl || !item.title?.startsWith('Watched ')) continue;
    const videoId = extractYouTubeVideoId(item.titleUrl);
    if (!videoId) continue;
    const channel = item.subtitles?.[0];
    const channelIdMatch = channel?.url?.match(/channel\/(UC[\w-]{22})/);
    entries.push({
      videoId,
      source: 'youtube',
      title: item.title.replace(/^Watched /, ''),
      channelName: channel?.name ?? null,
      channelId: channelIdMatch?.[1] ?? null,
      watchedAt: item.time ? new Date(item.time).getTime() : Date.now(),
      durationSeconds: null,
    });
  }
  return entries;
}

function parseFeedTubeHistory(text: string): HistoryEntry[] {
  const j = JSON.parse(text) as { history?: HistoryEntry[] };
  if (!Array.isArray(j.history)) return [];
  return j.history;
}

function parseGrayjayHistoryEntry(raw: string): HistoryEntry | null {
  const parts = raw.split('|||');
  if (parts.length < 4) return null;
  const [url, timestampStr, durationStr, title] = parts;
  if (!url) return null;

  let source: SourceKind = 'youtube';
  let videoId: string | null = null;
  let channelId: string | null = null;

  if (url.includes('youtube.com') || url.includes('youtu.be')) {
    source = 'youtube';
    videoId = extractYouTubeVideoId(url);
  } else if (url.includes('soundcloud.com')) {
    source = 'soundcloud';
    videoId = url.split('/').pop() ?? url;
  } else if (url.includes('bilibili.com') || url.includes('b23.tv')) {
    source = 'bilibili';
    const m = /\/video\/(av\d+|BV[\w]+)/.exec(url);
    videoId = m?.[1] ?? url;
  } else if (url.includes('odysee.com') || url.includes('lbry.tv')) {
    source = 'odysee';
    videoId = url;
  } else if (url.includes('peertube')) {
    source = 'peertube';
    videoId = url;
  }

  if (!videoId) return null;

  return {
    videoId,
    source,
    title: title ?? null,
    channelName: null,
    channelId,
    watchedAt: timestampStr ? Number(timestampStr) * 1000 : Date.now(),
    durationSeconds: durationStr ? Number(durationStr) : null,
  };
}

export function parseHistoryFile(format: HistoryFormat, text: string | null): HistoryEntry[] {
  switch (format) {
    case 'freetube-history':
      return text ? parseFreeTubeHistory(text) : [];
    case 'youtube-history':
      return text ? parseYouTubeHistory(text) : [];
    case 'feedtube-history':
      return text ? parseFeedTubeHistory(text) : [];
    default:
      return [];
  }
}

export async function parseGrayjayHistoryFromFile(file: File): Promise<HistoryEntry[]> {
  const buf = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(buf);
  const historyFile = zip.file('stores/history');
  if (!historyFile) return [];
  const text = await historyFile.async('string');
  const trimmed = text.trim();
  if (!trimmed) return [];

  let lines: string[];
  try {
    const arr = JSON.parse(trimmed) as unknown;
    if (Array.isArray(arr)) {
      lines = arr.map((item) => (typeof item === 'string' ? item : JSON.stringify(item)));
    } else {
      lines = trimmed.split('\n');
    }
  } catch {
    lines = trimmed.split('\n');
  }

  const entries: HistoryEntry[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const entry = parseGrayjayHistoryEntry(trimmed);
    if (entry) entries.push(entry);
  }
  return entries;
}

export function isGrayjayHistoryFile(file: File): boolean {
  return file.name.toLowerCase().endsWith('.zip');
}
