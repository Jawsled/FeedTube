import JSZip from 'jszip';
import type { ImportedChannel, SourceKind } from '../types';

interface GrayjayChannelId {
  platform?: string;
  value?: string;
  pluginId?: string;
}

interface GrayjayChannel {
  id?: GrayjayChannelId;
  name?: string;
  thumbnail?: string;
  url?: string;
  urlAlternatives?: string[];
}

interface GrayjayGroup {
  id?: string;
  name?: string;
  urls?: string[];
}

const PLATFORM_TO_SOURCE: Record<string, SourceKind> = {
  YouTube: 'youtube',
  Odysee: 'odysee',
  BiliBili: 'bilibili',
  Bilibili: 'bilibili',
  PeerTube: 'peertube',
  SoundCloud: 'soundcloud',
};

function canonicalizeUrl(u: string): string {
  const trimmed = u.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith('lbry://')) {
    return `lbry:${trimmed.slice('lbry://'.length).split('#')[0] ?? ''}`;
  }
  try {
    const parsed = new URL(trimmed);
    parsed.hash = '';
    let host = parsed.hostname.replace(/^(www|m)\./, '').toLowerCase();
    if (host === 'youtube.com' || host === 'youtu.be') host = 'youtube.com';
    if (host === 'odysee.com' || host === 'lbry.tv') host = 'odysee.com';
    if (host === 'space.bilibili.com' || host === 'bilibili.com' || host === 'b23.tv') host = 'space.bilibili.com';
    let path = parsed.pathname;
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    return `${parsed.protocol}//${host}${path}`;
  } catch {
    return trimmed;
  }
}

function extractClaimId(lbryUrl: string): string | null {
  const m = /#([a-f0-9]{40})/i.exec(lbryUrl);
  return m ? m[1] : null;
}

function buildChannelMap(channels: GrayjayChannel[]): {
  byUrl: Map<string, GrayjayChannel>;
  byLbryHandle: Map<string, GrayjayChannel>;
  byLbryClaim: Map<string, GrayjayChannel>;
  pluginToPlatform: Map<string, SourceKind>;
} {
  const byUrl = new Map<string, GrayjayChannel>();
  const byLbryHandle = new Map<string, GrayjayChannel>();
  const byLbryClaim = new Map<string, GrayjayChannel>();
  const pluginToPlatform = new Map<string, SourceKind>();

  for (const c of channels) {
    if (!c?.id?.value) continue;
    const source = c.id.platform ? PLATFORM_TO_SOURCE[c.id.platform] ?? null : null;
    if (source && c.id.pluginId) {
      pluginToPlatform.set(c.id.pluginId, source);
    }
    const urls = [c.url, ...(c.urlAlternatives ?? [])].filter((u): u is string => typeof u === 'string');
    for (const u of urls) byUrl.set(canonicalizeUrl(u), c);
    if (c.url?.startsWith('lbry://')) {
      const stripped = c.url.slice('lbry://'.length);
      const handle = stripped.split('#')[0] ?? '';
      if (handle) byLbryHandle.set(handle, c);
      const claim = extractClaimId(c.url);
      if (claim) byLbryClaim.set(claim, c);
    }
  }
  return { byUrl, byLbryHandle, byLbryClaim, pluginToPlatform };
}

function findChannelForSubscription(
  rawUrl: string,
  maps: ReturnType<typeof buildChannelMap>,
): { channel: GrayjayChannel; source: SourceKind } | null {
  if (rawUrl.startsWith('lbry://')) {
    const stripped = rawUrl.slice('lbry://'.length);
    const claim = extractClaimId(rawUrl);
    const hit =
      (claim ? maps.byLbryClaim.get(claim) : null) ?? maps.byLbryHandle.get(stripped);
    if (hit) {
      const source = hit.id?.platform ? PLATFORM_TO_SOURCE[hit.id.platform] : null;
      if (source) return { channel: hit, source };
    }
    return null;
  }
  const hit = maps.byUrl.get(canonicalizeUrl(rawUrl));
  if (hit?.id?.platform) {
    const source = PLATFORM_TO_SOURCE[hit.id.platform];
    if (source) return { channel: hit, source };
  }
  return null;
}

interface RawSubscriptionEntry {
  url: string;
  tags: string[];
  channel: GrayjayChannel | null;
  source: SourceKind | null;
}

async function readJsonOrArray<T>(zip: JSZip, path: string): Promise<T[] | null> {
  const file = zip.file(path);
  if (!file) return null;
  const text = await file.async('string');
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) return [];
      const first = parsed[0];
      if (typeof first === 'string') {
        const looksLikeEncodedJson =
          first.startsWith('{') || first.startsWith('[') || first.startsWith('"');
        if (looksLikeEncodedJson) {
          return (parsed as string[]).map((s) => JSON.parse(s) as T);
        }
        return parsed as T[];
      }
      return parsed as T[];
    }
  } catch {
    /* fall through */
  }
  return trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}

function buildChannelRecord(entry: RawSubscriptionEntry): ImportedChannel | null {
  if (!entry.source) return null;
  const c = entry.channel;
  const rawUrl = entry.url.startsWith('lbry://') ? entry.url : canonicalizeUrl(entry.url);

  const base: ImportedChannel = {
    id: c?.id?.value ?? null,
    url: rawUrl,
    name: c?.name ?? null,
    avatarUrl: c?.thumbnail ?? null,
    tags: entry.tags,
    source: entry.source,
  };

  if (entry.source === 'odysee') {
    const alts = c?.urlAlternatives ?? [];
    const slugCandidate = alts.find((a) => /^https?:\/\/odysee\.com\/@.+/i.test(a));
    if (slugCandidate) {
      const m = /odysee\.com\/(@[A-Za-z0-9_-]+:[a-z0-9]+)/i.exec(slugCandidate);
      if (m) {
        return { ...base, urlSlug: m[1], url: slugCandidate } as ImportedChannel;
      }
    }
    const stripped = entry.url.replace(/^lbry:\/\//, '').split('#')[0] ?? '';
    if (stripped.startsWith('@')) {
      return { ...base, urlSlug: stripped } as ImportedChannel;
    }
  }

  if (entry.source === 'soundcloud') {
    // Grayjay gives us the SoundCloud *numeric* user id. That doesn't
    // work with our adapter (the v2 API only accepts permalinks at
    // /resolve). Try to extract the permalink from any of the URLs
    // the export knows about, so the channel has a usable id.
    const candidates = [c?.url, ...(c?.urlAlternatives ?? [])].filter(
      (u): u is string => typeof u === 'string',
    );
    for (const u of candidates) {
      const m = /soundcloud\.com\/([A-Za-z0-9._-]+)(?:\/|$|\?)/i.exec(u);
      if (m && m[1] && !/^on$/.test(m[1])) {
        const permalink = m[1].toLowerCase();
        return { ...base, id: `sc_${permalink}`, urlSlug: permalink, url: u } as ImportedChannel;
      }
    }
  }

  return base;
}

export async function parseGrayjay(file: File): Promise<ImportedChannel[]> {
  const buf = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(buf);

  const exportInfoEntry = zip.file('exportInfo');
  if (!exportInfoEntry) {
    throw new Error('Not a Grayjay export (missing exportInfo file)');
  }

  const subsRaw = await readJsonOrArray<string>(zip, 'stores/Subscriptions');
  const subsList: string[] = Array.isArray(subsRaw) ? subsRaw : [];
  if (subsList.length === 0) {
    throw new Error('Grayjay export has no subscriptions');
  }

  const groupsRaw = await readJsonOrArray<GrayjayGroup>(zip, 'stores/subscription_groups');
  const groups: GrayjayGroup[] = Array.isArray(groupsRaw) ? groupsRaw : [];

  const channelsRaw = await readJsonOrArray<GrayjayChannel>(zip, 'cache_channels');
  const channels: GrayjayChannel[] = Array.isArray(channelsRaw) ? channelsRaw : [];
  const maps = buildChannelMap(channels);

  const tagsByUrl = new Map<string, string[]>();
  for (const g of groups) {
    const tagName = (g.name ?? '').trim();
    if (!tagName) continue;
    for (const u of g.urls ?? []) {
      const key = canonicalizeUrl(u);
      const list = tagsByUrl.get(key) ?? [];
      if (!list.includes(tagName)) list.push(tagName);
      tagsByUrl.set(key, list);
    }
  }

  const seen = new Set<string>();
  const out: ImportedChannel[] = [];
  for (const url of subsList) {
    const key = canonicalizeUrl(url);
    if (seen.has(key)) continue;
    seen.add(key);
    const match = findChannelForSubscription(url, maps);
    const tags = tagsByUrl.get(key) ?? [];
    const entry: RawSubscriptionEntry = {
      url,
      tags,
      channel: match?.channel ?? null,
      source: match?.source ?? null,
    };
    if (match?.source) {
      const record = buildChannelRecord(entry);
      if (record) {
        out.push(record);
        continue;
      }
    }
    out.push({
      id: null,
      url,
      name: match?.channel?.name ?? null,
      avatarUrl: match?.channel?.thumbnail ?? null,
      tags,
    });
  }
  return out;
}

const ZIP_SNIFF_HEAD = 4;

export async function isGrayjayExport(file: File): Promise<boolean> {
  if (!file.name.toLowerCase().endsWith('.zip')) return false;
  try {
    if (file.size < 22) return false;
    const head = new Uint8Array(await file.slice(0, ZIP_SNIFF_HEAD).arrayBuffer());
    if (!/PK\x03\x04/.test(String.fromCharCode(...head.slice(0, 4)))) return false;
    const buf = await file.arrayBuffer();
    const zip = await JSZip.loadAsync(buf);
    return zip.file('exportInfo') != null;
  } catch {
    return false;
  }
}
