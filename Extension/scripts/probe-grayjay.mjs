import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = mkdtempSync(join(tmpdir(), 'feedtube-grayjay-'));

await build({
  entryPoints: [join(root, 'lib/io/import-grayjay.ts')],
  outdir,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outExtension: { '.js': '.mjs' },
});

const { parseGrayjay, isGrayjayExport } = await import(pathToFileURL(join(outdir, 'import-grayjay.mjs')).href);

class FakeFile {
  constructor(name, bytes) {
    this.name = name;
    this.size = bytes.length;
    this._bytes = bytes;
  }
  async arrayBuffer() {
    return this._bytes.buffer.slice(this._bytes.byteOffset, this._bytes.byteOffset + this._bytes.byteLength);
  }
  slice(start, end) {
    const sub = end != null ? this._bytes.subarray(start, end) : this._bytes.subarray(start);
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

const zipPath = process.argv[2] ?? join(root, 'export_2026-08-29_0054.zip');
const zipBytes = readFileSync(zipPath);
const file = new FakeFile(zipPath, new Uint8Array(zipBytes));

console.log('isGrayjayExport:', await isGrayjayExport(file));
const items = await parseGrayjay(file);
console.log('parsed entries:', items.length);

const biliGrouped = items.filter((c) => (c.tags ?? []).includes('BiliBili'));
console.log('BiliBili-tagged:', biliGrouped.length);
for (const c of biliGrouped.slice(0, 3)) {
  console.log(`  - ${c.name} (${c.url}) tags=${JSON.stringify(c.tags)}`);
}

const bySource = new Map();
for (const c of items) {
  const k = c.source ?? 'unknown';
  bySource.set(k, (bySource.get(k) ?? 0) + 1);
}
console.log('by source:', Object.fromEntries(bySource));

const withId = items.filter((c) => c.id != null);
const noId = items.filter((c) => c.id == null);
console.log('with id:', withId.length, '/ without id (unsupported platform):', noId.length);

const withTags = items.filter((c) => (c.tags ?? []).length > 0);
console.log('with tags:', withTags.length);
for (const c of withTags.slice(0, 5)) {
  console.log(`  ${c.name} → [${c.tags.join(', ')}]`);
}

const ody = items.filter((c) => c.source === 'odysee');
console.log('\nOdysee items:');
for (const c of ody) {
  console.log(`  - id=${c.id} slug=${c.urlSlug} name=${c.name} url=${c.url}`);
}
