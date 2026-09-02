import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = mkdtempSync(join(tmpdir(), 'feedtube-smoke-'));

await build({
  entryPoints: [join(root, 'lib/api/sources.ts'), join(root, 'lib/api/rss.ts'), join(root, 'lib/utils.ts')],
  outdir,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outExtension: { '.js': '.mjs' },
});

const imp = (name) => import(pathToFileURL(join(outdir, name)).href);
const { browseChannel, parseChannelVideos, parseChannelMeta } = await imp('api/sources.mjs');
const { fetchChannelRss } = await imp('api/rss.mjs');
const { relativeToEpoch, parseCount, hmsToSeconds } = await imp('utils.mjs');
const { detectSource, getSource, odyseeAdapter, bilibiliAdapter } = await imp('api/sources.mjs');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name} ${detail}`);
  }
}

const FIRESHIP = 'UCsBjURrPoezykLs9EqgamOA';

console.log('unit helpers');
check('relativeToEpoch "2 days ago"', Math.abs(relativeToEpoch('2 days ago') - (Date.now() - 2 * 86400000)) < 60000);
check('relativeToEpoch "1 hour ago"', Math.abs(relativeToEpoch('1 hour ago') - (Date.now() - 3600000)) < 60000);
check('relativeToEpoch "Streamed 3 weeks ago"', relativeToEpoch('Streamed 3 weeks ago') != null);
check('relativeToEpoch junk', relativeToEpoch('12K views') == null);
check('parseCount "1.2M views"', parseCount('1.2M views') === 1200000);
check('parseCount "1,234,567 views"', parseCount('1,234,567 views') === 1234567);
check('hms "1:02:03"', hmsToSeconds('1:02:03') === 3723);
check('hms "4:05"', hmsToSeconds('4:05') === 245);

console.log('native innertube browse (live)');
try {
  const json = await browseChannel(FIRESHIP, 'videos');
  const videos = parseChannelVideos(json);
  const meta = parseChannelMeta(json);
  console.log(`  parsed ${videos.length} videos; channel name: ${meta.name}`);
  check('native videos parsed', videos.length >= 10, `got ${videos.length}`);
  check(
    'videos have ids+titles',
    videos.every((v) => v.id && v.title),
  );
  check('some have view counts', videos.filter((v) => v.viewCount != null).length > 0);
  const raw = JSON.stringify(json);
  check(
    'renderer detection',
    /lockupViewModel/.test(raw) || /videoRenderer/.test(raw),
    'neither renderer present',
  );
  if (/lockupViewModel/.test(raw)) console.log('  note: response uses lockupViewModel (new renderer)');
} catch (e) {
  failures++;
  console.error('  FAIL native browse threw:', e.message);
}

console.log('rss fallback (live)');
try {
  const rss = await fetchChannelRss(FIRESHIP);
  console.log(`  parsed ${rss.videos.length} entries; author: ${rss.name}`);
  check('rss entries parsed', rss.videos.length >= 5, `got ${rss.videos.length}`);
  check('rss exact dates', rss.videos.every((v) => v.publishedAt != null));
  check('rss author', rss.name != null);
} catch (e) {
  failures++;
  console.error('  FAIL rss threw:', e.message);
}

console.log('source dispatch (no network)');
check('detect YouTube url', detectSource('https://www.youtube.com/@mkbhd') === 'youtube');
check('detect YouTube bare id', detectSource('UCsBjURrPoezykLs9EqgamOA') === 'youtube');
check('detect Odysee url', detectSource('https://odysee.com/@Odysee:9') === 'odysee');
check('detect Odysee handle', detectSource('@Odysee:9') === 'odysee');
check('detect Bilibili space url', detectSource('https://space.bilibili.com/946974') === 'bilibili');
check('detect Bilibili mid', detectSource('946974') === 'bilibili');
check('detect unknown', detectSource('hello world') === null);
check('youtubeAdapter registered', getSource('youtube').kind === 'youtube');
check('odyseeAdapter registered', getSource('odysee').kind === 'odysee');
check('bilibiliAdapter registered', getSource('bilibili').kind === 'bilibili');
check('bilibili watchUrl is bilibili.com', getSource('bilibili').watchUrl('BV1xx411c7mD', 'video') === 'https://www.bilibili.com/video/BV1xx411c7mD');
check('odysee watchUrl is odysee.com', getSource('odysee').watchUrl('abc123', 'video').startsWith('https://odysee.com/'));
void odyseeAdapter;
void bilibiliAdapter;

process.exit(failures === 0 ? 0 : 1);
