import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = mkdtempSync(join(tmpdir(), 'feedtube-odysee-'));

await build({
  entryPoints: [join(root, 'lib/api/odysee.ts')],
  outdir,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outExtension: { '.js': '.mjs' },
});

const { odyseeAdapter } = await import(pathToFileURL(join(outdir, 'odysee.mjs')).href);
void odyseeAdapter;

const args = process.argv.slice(2);
const input = args[0] || '@Odysee:9';

console.log(`Resolving Odysee channel for: ${input}`);
try {
  const resolved = await odyseeAdapter.resolveChannel(input);
  console.log('resolved:', resolved);
  console.log('\nFetching latest uploads…');
  const result = await odyseeAdapter.fetchChannel(resolved.id, undefined, { name: resolved.name, avatarUrl: resolved.avatarUrl, urlSlug: resolved.urlSlug });
  console.log(`name: ${result.name}`);
  console.log(`avatar: ${result.avatarUrl}`);
  console.log(`videos: ${result.videos.length}`);
  for (const v of result.videos.slice(0, 5)) {
    console.log(`  - [${v.kind}] ${v.title} (${v.id})`);
  }
} catch (e) {
  console.error('FAILED:', e.message);
  process.exit(1);
}
