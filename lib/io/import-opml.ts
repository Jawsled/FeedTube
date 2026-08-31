import { XMLParser } from 'fast-xml-parser';
import type { ImportedChannel, SourceKind } from '../types';
import { dedupeChannels, playlistToChannelId } from './common';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
});

interface Outline {
  '@_title'?: string;
  '@_text'?: string;
  '@_xmlUrl'?: string;
  '@_htmlUrl'?: string;
  outline?: Outline | Outline[];
}

function bilibiliMidFromUrl(u: URL): string | null {
  if (u.hostname !== 'rsshub.app' && u.hostname !== 'api.bilibili.com') return null;
  const m = u.pathname.match(/\/bilibili\/user\/video\/(\d+)/);
  if (m) return m[1];
  return null;
}

function collect(outline: Outline | undefined, out: ImportedChannel[]): void {
  if (!outline) return;
  const xmlUrl = outline['@_xmlUrl'];
  if (xmlUrl) {
    let url: URL | null = null;
    try {
      url = new URL(xmlUrl);
    } catch {
      url = null;
    }
    if (url) {
      const host = url.hostname;
      let source: SourceKind | null = null;
      let id: string | null = null;
      let channelUrl: string | null = null;

      if (/youtube\.com$/.test(host) && /\/feeds\/videos\.xml/i.test(url.pathname)) {
        const cid = url.searchParams.get('channel_id');
        const pid = url.searchParams.get('playlist_id');
        id = cid ?? (pid ? playlistToChannelId(pid) : null);
        if (id) {
          source = 'youtube';
          channelUrl = `https://www.youtube.com/channel/${id}`;
        }
      } else if (/odysee\.com$/.test(host) && /\/rss/i.test(url.pathname)) {
        const claimId = url.pathname.match(/\/([^/.\s]+)\/rss/i)?.[1] ?? null;
        if (claimId) {
          id = claimId;
          source = 'odysee';
          channelUrl = `https://odysee.com/${claimId}`;
        }
      } else {
        const biliMid = bilibiliMidFromUrl(url);
        if (biliMid) {
          id = biliMid;
          source = 'bilibili';
          channelUrl = `https://space.bilibili.com/${biliMid}`;
        } else if (host === 'feeds.soundcloud.com' && /\/usersoundcloud:([^/]+)\/sounds\.rss/i.test(url.pathname)) {
          const m = /\/usersoundcloud:([^/]+)\/sounds\.rss/i.exec(url.pathname);
          const handle = m?.[1] ?? '';
          if (handle) {
            id = `sc_${handle}`;
            source = 'soundcloud';
            channelUrl = `https://soundcloud.com/${handle}`;
          }
        } else {
          // PeerTube: any host serving /feeds/accounts/<handle>.atom
          const ptMatch = url.pathname.match(/\/feeds\/accounts\/([^/.]+)\.atom$/i);
          if (ptMatch) {
            const handle = ptMatch[1] ?? '';
            const hostOnly = url.hostname.replace(/^www\./, '');
            if (handle) {
              id = `peertube:${hostOnly}@${handle}`;
              source = 'peertube';
              channelUrl = `https://${hostOnly}/@${handle}`;
            }
          }
        }
      }

      if (source && id) {
        out.push({
          id,
          url: channelUrl,
          name: outline['@_title'] ?? outline['@_text'] ?? null,
          avatarUrl: null,
          source,
        });
      }
    }
  }
  for (const child of Array.isArray(outline.outline) ? outline.outline : [outline.outline]) {
    collect(child, out);
  }
}

export function parseOpml(text: string): ImportedChannel[] {
  const doc = parser.parse(text) as { opml?: { body?: { outline?: Outline | Outline[] } } };
  const body = doc.opml?.body;
  if (!body) throw new Error('Not a valid OPML file');
  const items: ImportedChannel[] = [];
  for (const o of Array.isArray(body.outline) ? body.outline : body.outline ? [body.outline] : []) {
    collect(o, items);
  }
  return dedupeChannels(items);
}
