import puppeteer from 'puppeteer-core';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ext = join(root, '.output', 'chrome-mv3');

const workdir = mkdtempSync(join(tmpdir(), 'feedtube-e2e-'));

const NP_JSON = join(workdir, 'newpipe-subscriptions.json');
writeFileSync(
  NP_JSON,
  JSON.stringify({
    app_version: '0.27.2',
    app_version_int: 989,
    subscriptions: [
      {
        service_id: 0,
        url: 'https://www.youtube.com/channel/UCsBjURrPoezykLs9EqgamOA',
        name: 'Fireship',
        avatar_url: 'https://yt3.ggpht.com/ytc/xxx',
      },
      {
        service_id: 0,
        url: 'https://www.youtube.com/channel/UCsBjURrPoezykLs9EqgamOA',
        name: 'Fireship dup',
      },
    ],
  }),
);

const initSqlJs = (await import('sql.js')).default;
const SQL = await initSqlJs();
const db = new SQL.Database();
db.run(
  'CREATE TABLE subscriptions (uid INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, service_id INTEGER NOT NULL, url TEXT, name TEXT, avatar_url TEXT, subscriber_count INTEGER, description TEXT)',
);
db.run(
  "INSERT INTO subscriptions (service_id,url,name) VALUES (0,'https://www.youtube.com/channel/UCXuqSBlHAE6Xw-yeJA0Tunw','Linus Tech Tips'),(1,'https://soundcloud.com/x','SC')",
);
const NP_DB = join(workdir, 'newpipe.db');
writeFileSync(NP_DB, Buffer.from(db.export()));

const browser = await puppeteer.launch({
  executablePath:
    'C:\\Users\\pttx\\.cache\\puppeteer\\chrome\\win64-152.0.7977.54\\chrome-win64\\chrome.exe',
  headless: true,
  args: [
    `--disable-extensions-except=${ext}`,
    `--load-extension=${ext}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=DialMediaRouteProvider',
  ],
});

try {
  const swTarget = await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'),
    { timeout: 15000 },
  );
  const extId = new URL(swTarget.url()).host;
  console.log('extension id:', extId);

  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(`[console.${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', (r) =>
    logs.push(`[requestfailed] ${r.url().slice(0, 120)} :: ${r.failure()?.errorText}`),
  );

  const readChannels = () =>
    page.evaluate(
      () =>
        new Promise((resolve) => {
          const rq = indexedDB.open('feedtube');
          rq.onsuccess = () => {
            const d = rq.result;
            const g = d.transaction('channels').objectStore('channels').getAll();
            g.onsuccess = () => {
              d.close();
              resolve(g.result.map((c) => ({ id: c.id, name: c.name })));
            };
            g.onerror = () => resolve(['<getAll failed>']);
          };
          rq.onerror = () => resolve(['<open failed>']);
        }),
    );

  async function tryImport(label, file) {
    console.log(`\n=== import ${label} ===`);
    await page.goto(`chrome-extension://${extId}/dashboard.html#/io`, { waitUntil: 'load' });
    await page.waitForSelector('input[type=file]', { timeout: 8000 });
    const input = await page.$('input[type=file]');
    await input.uploadFile(file);
    await new Promise((r) => setTimeout(r, 4000));
    const text = await page.evaluate(() => document.body.innerText);
    const relevant = text.split('\n').filter((l) => /detected|added|found|failed|Import/i.test(l));
    console.log(relevant.join('\n'));
    console.log('channels in db:', JSON.stringify(await readChannels()));
  }

  await tryImport('newpipe .json', NP_JSON);
  await tryImport('newpipe .db', NP_DB);

  console.log('\n=== manual add ===');
  await page.goto(`chrome-extension://${extId}/dashboard.html#/subs`, { waitUntil: 'load' });
  await page.waitForSelector('input[placeholder*="Channel"]', { timeout: 8000 });
  await page.type('input[placeholder*="Channel"]', 'https://www.youtube.com/@mkbhd');
  await page.click('button.primary');
  await new Promise((r) => setTimeout(r, 9000));
  console.log('channels in db:', JSON.stringify(await readChannels()));

  console.log('\n--- captured logs ---');
  for (const l of logs) console.log(l);
} finally {
  await browser.close();
}
