import puppeteer from 'puppeteer-core';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ext = join(root, '.output', 'chrome-mv3');
const workdir = mkdtempSync(join(tmpdir(), 'feedtube-e2e2-'));

const NP_JSON = join(workdir, 'np.json');
writeFileSync(
  NP_JSON,
  JSON.stringify({
    app_version: '0.27.2',
    app_version_int: 989,
    subscriptions: [
      {
        service_id: 0,
        url: 'https://www.youtube.com/channel/UCXuqSBlHAE6Xw-yeJA0Tunw',
        name: 'Linus Tech Tips',
      },
    ],
  }),
);

const browser = await puppeteer.launch({
  executablePath:
    'C:\\Users\\pttx\\.cache\\puppeteer\\chrome\\win64-152.0.7977.54\\chrome-win64\\chrome.exe',
  headless: true,
  args: [
    `--disable-extensions-except=${ext}`,
    `--load-extension=${ext}`,
    '--no-first-run',
    '--no-default-browser-check',
  ],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const swTarget = await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'),
    { timeout: 15000 },
  );
  const extId = new URL(swTarget.url()).host;
  const sw = await swTarget.worker();
  const swLogs = [];
  // attach console listener via CDP on the worker target
  const cdp = await swTarget.createCDPSession();
  cdp.on('Runtime.consoleAPICalled', (e) => {
    swLogs.push(`[sw.${e.type}] ${e.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
  });
  cdp.on('Runtime.exceptionThrown', (e) => {
    swLogs.push(`[sw.exception] ${e.exceptionDetails.text} ${e.exceptionDetails.exception?.description ?? ''}`);
  });
  console.log('extension id:', extId);

  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(`[console.${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', (r) =>
    logs.push(`[requestfailed] ${r.url().slice(0, 140)} :: ${r.failure()?.errorText}`),
  );
  page.on('response', (r) => {
    if (/youtube\.com|invidious/.test(r.url()) && r.status() >= 400) {
      logs.push(`[http ${r.status()}] ${r.url().slice(0, 140)}`);
    }
  });

  const readDb = () =>
    page.evaluate(
      () =>
        new Promise((resolve) => {
          const rq = indexedDB.open('feedtube');
          rq.onsuccess = () => {
            const d = rq.result;
            const chans = d.transaction('channels').objectStore('channels').getAll();
            const vids = d.transaction('videos').objectStore('videos').count();
            chans.onsuccess = () => {
              vids.onsuccess = () => {
                d.close();
                resolve({
                  channels: chans.result.map((c) => ({ id: c.id, name: c.name, err: c.lastError })),
                  videoCount: vids.result,
                });
              };
            };
          };
          rq.onerror = () => resolve({ error: 'idb open failed' });
        }),
    );

  const engineStatus = () =>
    page.evaluate(
      () =>
        new Promise((res) => {
          chrome.storage.local.get(['engineStatus'], (r) => res(r.engineStatus));
        }),
    );

  // step 1: import one channel
  await page.goto(`chrome-extension://${extId}/dashboard.html#/io`, { waitUntil: 'load' });
  await page.waitForSelector('input[type=file]');
  await (await page.$('input[type=file]')).uploadFile(NP_JSON);
  await sleep(2500);

  // step 2: watch refresh happen
  console.log('waiting for background refresh...');
  for (let i = 0; i < 12; i++) {
    await sleep(3000);
    const s = await engineStatus();
    const dbState = await readDb();
    console.log(
      `t+${(i + 1) * 3}s running=${s?.running} done=${s?.done}/${s?.total} errors=${JSON.stringify(s?.errors)} videos=${dbState.videoCount}`,
    );
    if (s && !s.running && s.done > 0) break;
  }

  console.log('\ndb state:', JSON.stringify(await readDb(), null, 1));
  console.log('\nsw logs:');
  swLogs.forEach((l) => console.log(l));
  console.log('\npage logs:');
  logs.forEach((l) => console.log(l));
} finally {
  await browser.close();
}
