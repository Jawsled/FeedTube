import puppeteer from 'puppeteer';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const extPath = join(root, '.output/chrome-mv3');

const browser = await puppeteer.launch({
  headless: 'new',
  args: [
    `--disable-extensions-except=${extPath}`,
    `--load-extension=${extPath}`,
    '--no-sandbox',
  ],
});

const targets = await browser.targets();
const extensionTarget = targets.find((t) => t.type() === 'service_worker');
if (!extensionTarget) {
  console.error('Extension service worker not found');
  console.error('targets:', targets.map((t) => ({ type: t.type(), url: t.url() })));
  await browser.close();
  process.exit(1);
}

const sw = await extensionTarget.worker();
console.log('Service worker URL:', extensionTarget.url());

// Extract extension ID
const m = extensionTarget.url().match(/^chrome-extension:\/\/([a-z]+)\//);
if (!m) {
  console.error('Could not parse extension ID');
  await browser.close();
  process.exit(1);
}
const extId = m[1];
console.log('Extension ID:', extId);

const dashUrl = `chrome-extension://${extId}/dashboard.html#/io`;
const page = await browser.newPage();
await page.goto(dashUrl, { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 1000));

console.log('Page URL:', page.url());
console.log('Page title:', await page.title());

// Find the engine status by opening storage
const status = await page.evaluate(async () => {
  const { default: chrome } = await import('wxt/browser');
  const obj = await chrome.storage.local.get('engineStatus');
  return obj.engineStatus ?? null;
});
console.log('Initial engine status:', status);

// Find any channels
const channels = await page.evaluate(async () => {
  const { default: chrome } = await import('wxt/browser');
  const req = indexedDB.open('feedtube', 3);
  return new Promise((resolve) => {
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('channels', 'readonly');
      const store = tx.objectStore('channels');
      const all = store.getAll();
      all.onsuccess = () => {
        resolve({ count: all.result.length, sample: all.result.slice(0, 3) });
      };
    };
    req.onerror = () => resolve({ error: req.error?.message });
  });
});
console.log('Channels in DB:', channels);

// Find any videos
const videos = await page.evaluate(async () => {
  const req = indexedDB.open('feedtube', 3);
  return new Promise((resolve) => {
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('videos', 'readonly');
      const store = tx.objectStore('videos');
      const all = store.getAll();
      all.onsuccess = () => {
        resolve({ count: all.result.length, sample: all.result.slice(0, 2) });
      };
    };
  });
});
console.log('Videos in DB:', videos);

await browser.close();
