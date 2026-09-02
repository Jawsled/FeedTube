import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = mkdtempSync(join(tmpdir(), 'feedtube-io-'));

await build({
  entryPoints: [
    join(root, 'lib/io/import-takeout-csv.ts'),
    join(root, 'lib/io/import-takeout-json.ts'),
    join(root, 'lib/io/import-newpipe-json.ts'),
    join(root, 'lib/io/import-opml.ts'),
    join(root, 'lib/io/export.ts'),
    join(root, 'lib/io/import-grayjay.ts'),
  ],
  outdir,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outExtension: { '.js': '.mjs' },
});

const imp = (name) => import(pathToFileURL(join(outdir, name)).href);
const { parseTakeoutCsv } = await imp('import-takeout-csv.mjs');
const { parseTakeoutJson } = await imp('import-takeout-json.mjs');
const { parseNewPipeJson } = await imp('import-newpipe-json.mjs');
const { parseOpml } = await imp('import-opml.mjs');
const { buildFeedTubeJson, buildOpml } = await imp('export.mjs');
const { isGrayjayExport, parseGrayjay } = await imp('import-grayjay.mjs');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name} ${detail}`);
  }
}

console.log('takeout csv');
const csvText = [
  'Channel Id,Channel Url,Channel Title',
  'UC1wUo-29zS7m_Jp-U_xYcFQ,http://www.youtube.com/channel/UC1wUo-29zS7m_Jp-U_xYcFQ,"Tool, Band"',
  'UCXuqSBlHAE6Xw-yeJA0Tunw,http://www.youtube.com/channel/UCXuqSBlHAE6Xw-yeJA0Tunw,Linus Tech Tips',
].join('\n');
const csv = parseTakeoutCsv(csvText);
check('csv rows', csv.length === 2, JSON.stringify(csv));
check('csv quoted title', csv[0]?.name === 'Tool, Band');

console.log('takeout json');
const takeoutJson = JSON.stringify([
  {
    kind: 'youtube#subscription',
    snippet: { title: 'Test', resourceId: { channelId: 'UC1234567890123456789012' } },
  },
]);
const tj = parseTakeoutJson(takeoutJson);
check('takeout json id+name', tj.length === 1 && tj[0].id === 'UC1234567890123456789012' && tj[0].name === 'Test');

console.log('newpipe json');
const npJson = JSON.stringify({
  app_version: '0.27.2',
  subscriptions: [
    { service_id: 0, url: 'https://www.youtube.com/channel/UC1234567890123456789012', name: 'A' },
    { service_id: 1, url: 'https://soundcloud.com/x', name: 'SoundCloud thing' },
  ],
});
const nj = parseNewPipeJson(npJson);
check('newpipe filters service_id', nj.length === 1 && nj[0].name === 'A');

console.log('opml');
const opmlText = `<?xml version="1.0"?>
<opml version="1.0">
  <head><title>subs</title></head>
  <body>
    <outline text="Group">
      <outline type="rss" text="Chan A" xmlUrl="https://www.youtube.com/feeds/videos.xml?channel_id=UC1111111111111111111111"/>
      <outline type="rss" text="Chan B" xmlUrl="https://www.youtube.com/feeds/videos.xml?playlist_id=UUB222222222222222222222"/>
      <outline type="rss" text="Chan C" xmlUrl="https://www.youtube.com/feeds/videos.xml?playlist_id=UULFC333333333333333333333"/>
    </outline>
  </body>
</opml>`;
const opml = parseOpml(opmlText);
check('opml nested outlines', opml.length === 3, JSON.stringify(opml));
check('opml playlist UU→UC', opml[1]?.id === 'UCB222222222222222222222');
check('opml playlist UULF→UC', opml[2]?.id === 'UCC333333333333333333333');

console.log('exports');
const chans = [{ id: 'UC1', source: 'youtube', name: 'A & B', avatarUrl: null, tags: [] }];
const json = buildFeedTubeJson(chans, []);
check('export json shape', json.app === 'FeedTube' && json.version === 3 && json.channels.length === 1 && json.channels[0].name === 'A & B' && json.channels[0].source === 'youtube');
const opmlOut = buildOpml(chans);
check('export opml escapes', opmlOut.includes('text="A &amp; B"'));

console.log('opml multi-source');
const multiOpml = `<?xml version="1.0"?>
<opml version="2.0">
  <head><title>subs</title></head>
  <body>
    <outline type="rss" text="A" xmlUrl="https://www.youtube.com/feeds/videos.xml?channel_id=UC1111111111111111111111"/>
    <outline type="rss" text="B" xmlUrl="https://odysee.com/abc123def456abc123def456abc123def4567890/rss"/>
  </body>
</opml>`;
const multi = parseOpml(multiOpml);
check('multi-source opml length', multi.length === 2, JSON.stringify(multi));
const sources = multi.map((m) => m.source).sort();
check('multi-source opml sources', JSON.stringify(sources) === JSON.stringify(['odysee', 'youtube']));

console.log('grayjay export');
const JSZipMod = await import('jszip');
const { default: JSZip } = JSZipMod;
const z = new JSZip();
z.file('exportInfo', '{"version":"1"}');
z.file('stores/Subscriptions', JSON.stringify([
  'https://www.youtube.com/channel/UC1111111111111111111111',
  'https://space.bilibili.com/12345',
  'lbry://@handle#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'https://soundcloud.com/foo',
]));
z.file('stores/subscription_groups', JSON.stringify([
  JSON.stringify({ id: 'g1', name: 'Music', urls: ['https://www.youtube.com/channel/UC1111111111111111111111'] }),
  JSON.stringify({ id: 'g2', name: 'Bilibili', urls: ['https://space.bilibili.com/12345'] }),
]));
z.file('cache_channels', JSON.stringify([
  { id: { platform: 'YouTube', value: 'UC1111111111111111111111', pluginId: 'yt' }, name: 'Channel A', thumbnail: 'https://example/a.jpg', url: 'https://www.youtube.com/channel/UC1111111111111111111111' },
  { id: { platform: 'BiliBili', value: '12345', pluginId: 'bili' }, name: 'B Channel', thumbnail: 'https://example/b.jpg', url: 'https://space.bilibili.com/12345' },
  { id: { platform: 'Odysee', value: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', pluginId: 'ody' }, name: 'O Channel', thumbnail: 'https://example/o.jpg', url: 'lbry://@handle#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', urlAlternatives: ['lbry://@handle#a', 'https://odysee.com/@handle:a'] },
]));
const zBuf = await z.generateAsync({ type: 'uint8array' });
class TestFile {
  constructor(name, bytes) {
    this.name = name;
    this.size = bytes.length;
    this._bytes = bytes;
  }
  async arrayBuffer() {
    return this._bytes.buffer.slice(this._bytes.byteOffset, this._bytes.byteOffset + this._bytes.byteLength);
  }
  slice(s, e) {
    const sub = e != null ? this._bytes.subarray(s, e) : this._bytes.subarray(s);
    return {
      size: sub.length,
      slice(s2, e2) {
        const sub2 = e2 != null ? sub.subarray(s2, e2) : sub.subarray(s2);
        return {
          size: sub2.length,
          arrayBuffer: async () => sub2.buffer.slice(sub2.byteOffset, sub2.byteOffset + sub2.byteLength),
        };
      },
      arrayBuffer: async () => sub.buffer.slice(sub.byteOffset, sub.byteOffset + sub.byteLength),
    };
  }
}
const f = new TestFile('grayjay.zip', zBuf);
check('isGrayjayExport true', await isGrayjayExport(f));
const gItems = await parseGrayjay(f);
check('grayjay 4 entries', gItems.length === 4, JSON.stringify(gItems.map((c) => ({ id: c.id, source: c.source, tags: c.tags }))));
const yt = gItems.find((c) => c.id === 'UC1111111111111111111111');
check('yt has id, source, tag', yt && yt.source === 'youtube' && yt.tags?.includes('Music'));
const bili = gItems.find((c) => c.id === '12345');
check('bili has id, source, tag', bili && bili.source === 'bilibili' && bili.tags?.includes('Bilibili'));
const ody = gItems.find((c) => c.id === 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
check('ody has id, source, slug', ody && ody.source === 'odysee' && ody.urlSlug === '@handle:a');
const sc = gItems.find((c) => c.url === 'https://soundcloud.com/foo');
check('soundcloud has no id (unsupported)', sc && sc.id == null && sc.source == null);
void JSZipMod;

process.exit(failures === 0 ? 0 : 1);
