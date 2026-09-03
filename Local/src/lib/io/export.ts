import type { ChannelRecord, SourceKind, TagDefinition } from '../types';
import { ALL_SOURCE_KINDS } from '../api/source';
import { escapeXml, sourceChannelUrl } from '../utils';
import JSZip from 'jszip';

export interface FeedTubeExport {
  app: 'FeedTube';
  version: 3;
  exportedAt: string;
  tags: TagDefinition[];
  channels: { id: string; source: SourceKind; name: string; avatarUrl: string | null; tags: string[] }[];
}

export function buildFeedTubeJson(channels: ChannelRecord[], tags: TagDefinition[]): FeedTubeExport {
  return {
    app: 'FeedTube',
    version: 3,
    exportedAt: new Date().toISOString(),
    tags,
    channels: channels.map((c) => ({
      id: c.id,
      source: c.source,
      name: c.name,
      avatarUrl: c.avatarUrl,
      tags: c.tags,
    })),
  };
}

function rssUrlFor(c: ChannelRecord): string | null {
  if (c.source === 'youtube') {
    return `https://www.youtube.com/feeds/videos.xml?channel_id=${c.id}`;
  }
  if (c.source === 'odysee') {
    return `https://odysee.com/${c.id}/rss`;
  }
  if (c.source === 'bilibili') {
    return null; // Bilibili has no public RSS
  }
  if (c.source === 'peertube') {
    const slug = c.urlSlug;
    if (!slug) return null;
    const host = c.id.startsWith('peertube:') ? c.id.slice('peertube:'.length).split('@')[0] : null;
    if (!host) return null;
    return `https://${host}/feeds/accounts/${slug}.atom`;
  }
  if (c.source === 'soundcloud') {
    const handle = c.urlSlug ?? (c.id.startsWith('sc_') ? c.id.slice(3) : null);
    if (!handle) return null;
    return `https://feeds.soundcloud.com/usersoundcloud:${handle}/sounds.rss`;
  }
  return null;
}

function htmlUrlFor(c: ChannelRecord): string {
  return sourceChannelUrl(c.source, c.id);
}

function buildOpmlFor(channels: ChannelRecord[], title: string): string {
  const outlines = channels
    .map((c) => {
      const xmlUrl = rssUrlFor(c);
      if (!xmlUrl) return null;
      return `    <outline type="rss" text="${escapeXml(c.name)}" title="${escapeXml(c.name)}" xmlUrl="${escapeXml(xmlUrl)}" htmlUrl="${escapeXml(htmlUrlFor(c))}"/>`;
    })
    .filter((s): s is string => s != null)
    .join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    '  <head>',
    `    <title>${escapeXml(title)}</title>`,
    `    <dateCreated>${new Date().toUTCString()}</dateCreated>`,
    '  </head>',
    '  <body>',
    outlines,
    '  </body>',
    '</opml>',
    '',
  ].join('\n');
}

export function buildOpml(channels: ChannelRecord[]): string {
  return buildOpmlFor(channels, 'FeedTube subscriptions');
}

export function buildOpmlBySource(channels: ChannelRecord[]): Record<SourceKind, string> {
  const grouped = Object.fromEntries(ALL_SOURCE_KINDS.map((k) => [k, [] as ChannelRecord[]])) as Record<SourceKind, ChannelRecord[]>;
  for (const c of channels) grouped[c.source].push(c);
  return {
    youtube: buildOpmlFor(grouped.youtube, 'FeedTube — YouTube'),
    odysee: buildOpmlFor(grouped.odysee, 'FeedTube — Odysee'),
    bilibili: buildOpmlFor(grouped.bilibili, 'FeedTube — Bilibili'),
    peertube: buildOpmlFor(grouped.peertube, 'FeedTube — PeerTube'),
    soundcloud: buildOpmlFor(grouped.soundcloud, 'FeedTube — SoundCloud'),
  };
}

export function buildNewPipeJson(channels: ChannelRecord[]): string {
  const SERVICE_YOUTUBE = 0;
  const subs = channels
    .filter((c) => c.source === 'youtube')
    .map((c) => ({
      service_id: SERVICE_YOUTUBE,
      url: `https://www.youtube.com/channel/${c.id}`,
      name: c.name,
    }));
  return JSON.stringify({ subscriptions: subs }, null, 2);
}

const GRAYJAY_PLATFORM_MAP: Record<SourceKind, string> = {
  youtube: 'YouTube',
  odysee: 'Odysee',
  bilibili: 'BiliBili',
  peertube: 'PeerTube',
  soundcloud: 'SoundCloud',
};

export async function buildGrayjayZip(channels: ChannelRecord[], tags: TagDefinition[]): Promise<Blob> {
  const zip = new JSZip();

  zip.file('exportInfo', JSON.stringify({
    version: 13,
    identifier: 'FeedTube',
    platform: 'Desktop',
    timestamp: Date.now(),
  }));

  const subs = channels.map((c) => sourceChannelUrl(c.source, c.id));
  zip.file('stores/Subscriptions', JSON.stringify(subs, null, 2));

  const cacheChannels = channels.map((c) => ({
    id: { platform: GRAYJAY_PLATFORM_MAP[c.source] ?? c.source, value: c.id },
    name: c.name,
    thumbnail: c.avatarUrl ?? null,
    url: sourceChannelUrl(c.source, c.id),
    urlAlternatives: [],
  }));
  zip.file('cache_channels', JSON.stringify(cacheChannels, null, 2));

  if (tags.length > 0) {
    const groups = tags.map((t) => ({
      name: t.name,
      urls: channels.filter((c) => c.tags.includes(t.name)).map((c) => sourceChannelUrl(c.source, c.id)),
    }));
    zip.file('stores/subscription_groups', JSON.stringify(groups, null, 2));
  }

  return zip.generateAsync({ type: 'blob' });
}
