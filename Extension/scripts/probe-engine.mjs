import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = mkdtempSync(join(tmpdir(), 'feedtube-engine-'));

await build({
  entryPoints: [join(root, 'lib/api/sources.ts'), join(root, 'lib/api/rss.ts')],
  outdir,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outExtension: { '.js': '.mjs' },
});

const { youtubeAdapter } = await import(pathToFileURL(join(outdir, 'api/sources.mjs')).href);
const { fetchChannelRss } = await import(pathToFileURL(join(outdir, 'api/rss.mjs')).href);

const FIRESHIP = 'UCsBjURrPoezykLs9EqgamOA';
console.log('Fetching RSS for Fireship...');
const rss = await fetchChannelRss(FIRESHIP);
console.log('author:', rss.name);
console.log('videos:', rss.videos.length);
if (rss.videos.length > 0) {
  const v = rss.videos[0];
  console.log('first video:', { id: v.id, title: v.title, publishedAt: v.publishedAt, kind: v.kind });
}
