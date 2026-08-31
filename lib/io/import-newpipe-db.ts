import initSqlJs from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import type { ImportedChannel } from '../types';
import { channelIdFromUrl, dedupeChannels } from './common';

let sqlPromise: Promise<initSqlJs.SqlJsStatic> | null = null;

async function getSql(): Promise<initSqlJs.SqlJsStatic> {
  sqlPromise ??= initSqlJs({ locateFile: () => wasmUrl });
  return sqlPromise;
}

export async function parseNewPipeDb(file: File): Promise<ImportedChannel[]> {
  const SQL = await getSql();
  const buf = new Uint8Array(await file.arrayBuffer());
  const db = new SQL.Database(buf);

  let rows: unknown[][] = [];
  try {
    const result = db.exec('SELECT url, name, avatar_url FROM subscriptions');
    rows = result[0]?.values ?? [];
  } finally {
    db.close();
  }

  const items: ImportedChannel[] = [];
  for (const row of rows) {
    const [url, name, avatarUrl] = row as [string | null, string | null, string | null];
    if (typeof url !== 'string' || !url.includes('youtube.com')) continue;
    items.push({
      id: channelIdFromUrl(url),
      url,
      name: typeof name === 'string' ? name : null,
      avatarUrl: typeof avatarUrl === 'string' ? avatarUrl : null,
    });
  }
  return dedupeChannels(items);
}
