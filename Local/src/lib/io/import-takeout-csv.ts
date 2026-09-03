import type { ImportedChannel } from '../types';
import { parseCsv } from './csv';
import { channelIdFromUrl, dedupeChannels } from './common';

export function parseTakeoutCsv(text: string): ImportedChannel[] {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idIdx = header.indexOf('channel id');
  const titleIdx = header.indexOf('channel title');
  const urlIdx = header.indexOf('channel url');
  if (idIdx === -1) {
    const nameIdx = header.indexOf('name');
    const urlCol = header.indexOf('url');
    if (nameIdx !== -1 && urlCol !== -1) {
      return dedupeChannels(
        rows
          .slice(1)
          .map((r) => ({
            id: channelIdFromUrl(r[urlCol]),
            url: r[urlCol] ?? null,
            name: r[nameIdx] ?? null,
          }))
          .filter((c) => c.id != null),
      );
    }
    throw new Error('CSV does not look like a YouTube subscriptions export');
  }
  return dedupeChannels(
    rows
      .slice(1)
      .map((r) => ({
        id: r[idIdx]?.match(/UC[\w-]{22}/)?.[0] ?? null,
        url: urlIdx !== -1 ? (r[urlIdx] ?? null) : null,
        name: titleIdx !== -1 ? (r[titleIdx] ?? null) : null,
        avatarUrl: null,
      }))
      .filter((c) => c.id != null),
  );
}
