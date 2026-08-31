import { listChannels, upsertChannels, upsertTag } from '../db';
import { resolveChannel } from '../api/resolve-channel';
import { autoCategorizeChannel } from '../api/categorize';
import type { ChannelRecord, ImportedChannel, ImportSummary, SourceKind } from '../types';
import { parseNewPipeDb } from './import-newpipe-db';
import { parseNewPipeJson } from './import-newpipe-json';
import { parseTakeoutCsv } from './import-takeout-csv';
import { parseTakeoutJson } from './import-takeout-json';
import { parseOpml } from './import-opml';
import { isFreeTubeDb, parseFreeTubeDb } from './import-freetube-db';
import { isGrayjayExport, parseGrayjay } from './import-grayjay';

export type ImportFormat =
  | 'newpipe-db'
  | 'freetube-db'
  | 'newpipe-json'
  | 'takeout-json'
  | 'takeout-csv'
  | 'opml'
  | 'feedtube-json'
  | 'grayjay'
  | 'unknown';

async function sniffJson(text: string): Promise<ImportFormat> {
  const j = JSON.parse(text) as Record<string, unknown>;
  if (j && typeof j === 'object') {
    if (j.app === 'FeedTube') return 'feedtube-json';
    if (Array.isArray(j.subscriptions)) {
      const first = (j.subscriptions as Record<string, unknown>[])[0];
      if (first && 'service_id' in first) return 'newpipe-json';
      if (first?.snippet) return 'takeout-json';
      return 'newpipe-json';
    }
  }
  throw new Error('Unrecognized JSON structure');
}

export async function detectFormat(file: File): Promise<{ format: ImportFormat; text: string | null }> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.db') || name.endsWith('.sqlite')) {
    const text = await file.text();
    if (text.charCodeAt(0) === 0x7b) {
      return { format: 'freetube-db', text };
    }
    return { format: 'newpipe-db', text: null };
  }
  if (name.endsWith('.zip')) {
    if (await isGrayjayExport(file)) {
      return { format: 'grayjay', text: null };
    }
    throw new Error('ZIP files other than Grayjay exports are not supported');
  }
  if (name.endsWith('.opml')) return { format: 'opml', text: await file.text() };
  if (name.endsWith('.csv')) return { format: 'takeout-csv', text: await file.text() };
  if (name.endsWith('.json')) {
    const text = await file.text();
    try {
      return { format: await sniffJson(text), text };
    } catch {
      throw new Error('Invalid JSON file');
    }
  }
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const magic = String.fromCharCode(...head);
  if (magic.startsWith('SQLite format 3')) return { format: 'newpipe-db', text: null };
  throw new Error(`Unsupported file type: ${name || 'unknown'}`);
}

export function parseFile(format: ImportFormat, file: File, text: string | null): Promise<ImportedChannel[]> {
  switch (format) {
    case 'newpipe-db':
      return parseNewPipeDb(file);
    case 'freetube-db':
      return Promise.resolve(parseFreeTubeDb(text!));
    case 'newpipe-json':
      return Promise.resolve(parseNewPipeJson(text!));
    case 'takeout-json':
      return Promise.resolve(parseTakeoutJson(text!));
    case 'takeout-csv':
      return Promise.resolve(parseTakeoutCsv(text!));
    case 'opml':
      return Promise.resolve(parseOpml(text!));
    case 'grayjay':
      return parseGrayjay(file);
    case 'feedtube-json': {
      const j = JSON.parse(text!) as {
        channels?: (ImportedChannel & { source?: SourceKind })[];
        tags?: { name: string; color: string; refreshIntervalMin: number }[];
      };
      if (!Array.isArray(j.channels)) throw new Error('Not a FeedTube export');
      if (Array.isArray(j.tags)) {
        for (const t of j.tags) {
          if (t?.name) {
            void upsertTag({
              name: t.name,
              color: t.color ?? '#f0484a',
              refreshIntervalMin: t.refreshIntervalMin ?? 60,
            });
          }
        }
      }
      return Promise.resolve(
        j.channels.map((c) => ({
          ...c,
          id: c.id ?? null,
          source: c.source ?? 'youtube',
        })),
      );
    }
    default:
      return Promise.reject(new Error('Unsupported format'));
  }
}

const FORMAT_LABELS: Record<ImportFormat, string> = {
  'newpipe-db': 'NewPipe database (.db)',
  'freetube-db': 'FreeTube subscriptions (.db)',
  'newpipe-json': 'NewPipe subscriptions (.json)',
  'takeout-json': 'Google Takeout subscriptions (.json)',
  'takeout-csv': 'Google Takeout subscriptions (.csv)',
  opml: 'OPML subscription list',
  'feedtube-json': 'FeedTube export',
  grayjay: 'Grayjay export (.zip)',
  unknown: 'Unknown',
};

export async function importFromFile(file: File): Promise<ImportSummary> {
  const { format, text } = await detectFormat(file);
  const parsed = await parseFile(format, file, text);

  const existing = new Set((await listChannels()).map((c) => `${c.source}:${c.id}`));
  const toAdd: ChannelRecord[] = [];
  const failed: { input: string; error: string }[] = [];
  let duplicates = 0;

  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i];
    let id = item.id;
    let source: SourceKind = item.source ?? 'youtube';
    try {
      if (!id) {
        const resolved = await resolveChannel(item.url ?? item.name ?? '');
        id = resolved.id;
        source = resolved.source;
        if (existing.has(`${source}:${id}`)) {
          duplicates++;
          continue;
        }
      }
      if (existing.has(`${source}:${id}`)) {
        duplicates++;
        continue;
      }
      existing.add(`${source}:${id}`);
      toAdd.push({
        id,
        source,
        name: item.name ?? id,
        avatarUrl: item.avatarUrl ?? null,
        tags: item.tags ?? [],
        addedAt: Date.now() + i,
        lastFetchedAt: null,
        lastVideosFetchedAt: null,
        lastShortsFetchedAt: null,
        lastLiveFetchedAt: null,
        lastError: null,
        urlSlug: (item as { urlSlug?: string | null }).urlSlug ?? null,
      });
    } catch (e) {
      failed.push({ input: item.url ?? item.name ?? '(unnamed)', error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (toAdd.length > 0) {
    await upsertChannels(toAdd);
    for (const ch of toAdd) {
      if (ch.source === 'youtube') {
        autoCategorizeChannel({ id: ch.id, source: ch.source }, []).catch(() => undefined);
      }
    }
  }

  return {
    detected: FORMAT_LABELS[format],
    parsed: parsed.length,
    added: toAdd.length,
    duplicates,
    failed,
  };
}
