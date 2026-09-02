import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

// Node's WebCrypto lacks SHA-1/MD5 (Chrome has them); shim for node-only runs.
const subtle = globalThis.crypto?.subtle;
if (subtle) {
  const origDigest = subtle.digest.bind(subtle);
  subtle.digest = async (algo, data) => {
    const name = typeof algo === 'string' ? algo.toUpperCase() : String(algo.name ?? '').toUpperCase();
    if (name === 'SHA-1' || name === 'MD5') {
      const h = createHash(name === 'SHA-1' ? 'sha1' : 'md5').update(Buffer.from(data)).digest();
      return new Uint8Array(h).buffer;
    }
    return origDigest(algo, data);
  };
}

// In-memory chrome.storage.local shim (bili-cookies persists the rate-limit cooldown there).
{
  const mem = new Map();
  const shim = {
    storage: {
      local: {
        get: async (k) => {
          if (typeof k === 'string') return { [k]: mem.get(k) };
          if (Array.isArray(k)) return Object.fromEntries(k.map((x) => [x, mem.get(x)]));
          return Object.fromEntries(mem);
        },
        set: async (o) => { for (const [k, v] of Object.entries(o)) mem.set(k, v); },
        remove: async (k) => {
          if (typeof k === 'string') mem.delete(k);
          else if (Array.isArray(k)) k.forEach((x) => mem.delete(x));
        },
      },
    },
    runtime: { id: 'shim' },
  };
  globalThis.browser = shim;
  globalThis.chrome = shim;
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = mkdtempSync(join(tmpdir(), 'feedtube-bili-'));

await build({
  entryPoints: [join(root, 'lib/api/bilibili.ts')],
  outdir,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outExtension: { '.js': '.mjs' },
});

const { bilibiliAdapter } = await import(pathToFileURL(join(outdir, 'bilibili.mjs')).href);
void bilibiliAdapter;

const args = process.argv.slice(2);
const input = args[0] || '946974';

console.log(`Resolving Bilibili channel for: ${input}`);
try {
  const resolved = await bilibiliAdapter.resolveChannel(input);
  console.log('resolved:', resolved);
  console.log('\nFetching latest uploads…');
  const result = await bilibiliAdapter.fetchChannel(resolved.id, undefined, { name: resolved.name, avatarUrl: resolved.avatarUrl });
  console.log(`name: ${result.name}`);
  console.log(`avatar: ${result.avatarUrl}`);
  console.log(`backend: ${result.backendDetail ?? 'unknown'}`);
  console.log(`videos: ${result.videos.length}`);
  for (const v of result.videos.slice(0, 5)) {
    console.log(`  - [${v.kind}] ${v.title} (${v.id})`);
  }
} catch (e) {
  console.error('FAILED:', e.message);
  process.exit(1);
}
