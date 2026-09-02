import puppeteer from 'puppeteer-core';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ext = join(root, '.output', 'chrome-mv3');
const workdir = mkdtempSync(join(tmpdir(), 'feedtube-final-'));

const NP_JSON = join(workdir, 'np.json');
writeFileSync(
  NP_JSON,
  JSON.stringify({
    app_version: '0.27.2',
    app_version_int: 989,
    subscriptions: [
      { service_id: 0, url: 'https://www.youtube.com/channel/UCXuqSBlHAE6Xw-yeJA0Tunw', name: 'Linus Tech Tips' },
      { service_id: 0, url: 'https://www.youtube.com/channel/UCsBjURrPoezykLs9EqgamOA', name: 'Fireship' },
      { service_id: 1, url: 'https://soundcloud.com/x', name: 'should be skipped' },
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
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' :: ' + detail}`);
  if (!ok) failures++;
};

try {
  const t = await browser.waitForTarget(
    (x) => x.type() === 'service_worker' && x.url().startsWith('chrome-extension://'),
    { timeout: 15000 },
  );
  const extId = new URL(t.url()).host;
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('response', (r) => {
    if (/youtube\.com/.test(r.url()) && r.status() >= 400)
      errors.push(`http ${r.status()} ${r.url().slice(0, 100)}`);
  });

  // 1. import
  await page.goto(`chrome-extension://${extId}/dashboard.html#/io`, { waitUntil: 'load' });
  await page.waitForSelector('input[type=file]');
  await (await page.$('input[type=file]')).uploadFile(NP_JSON);
  await sleep(2500);
  let text = await page.evaluate(() => document.body.innerText);
  check('import summary shows 2 added', /2 added/.test(text), text.match(/.*added.*/)?.[0] ?? '');

  // 2. refresh completes
  let done = false;
  for (let i = 0; i < 15 && !done; i++) {
    await sleep(2000);
    done = await page.evaluate(
      () =>
        new Promise((res) =>
          chrome.storage.local.get(['engineStatus'], (r) => res(!r.engineStatus?.running)),
        ),
    );
  }
  check('refresh finished', done);

  // 3. channels healthy
  text = await page.evaluate(() => document.body.innerText);
  await page.goto(`chrome-extension://${extId}/dashboard.html#/subs`, { waitUntil: 'load' });
  await sleep(800);
  text = await page.evaluate(() => document.body.innerText);
  check('subscriptions listed', text.includes('Fireship') && text.includes('Linus Tech Tips'));
  check('no channel errors shown', !text.includes('⚠'));

  // 4. feed renders cards
  await page.goto(`chrome-extension://${extId}/dashboard.html#/feed`, { waitUntil: 'load' });
  await sleep(1500);
  const cardCount = await page.evaluate(() => document.querySelectorAll('main .video-card').length);
  check('feed renders videos', cardCount > 10, `got ${cardCount} cards`);

  // filter chips exist
  const chips = await page.evaluate(() =>
    [...document.querySelectorAll('main .chip')].map((c) => c.textContent.trim()),
  );
  check(
    'filter chips present',
    ['All', 'Videos', 'Shorts', 'Live'].every((c) => chips.includes(c)),
    chips.join(','),
  );

  // 5. popup renders unseen items
  const popup = await browser.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'load' });
  await sleep(1200);
  const popupText = await popup.evaluate(() => document.body.innerText);
  check('popup shows unread count', /\d+ unseen/.test(popupText), popupText.slice(0, 80));
  check('popup lists videos', popupText.includes('ago'), '');
  await popup.close();

  // 6. badge set
  const badge = await page.evaluate(
    () =>
      new Promise((res) => chrome.action.getBadgeText({}, (r) => res(r))),
  );
  check('badge has unread number', /^\d+$/.test(badge), badge);

  check('no page errors / http>=400 on youtube calls', errors.length === 0, errors.join(' | '));

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  await browser.close();
}
