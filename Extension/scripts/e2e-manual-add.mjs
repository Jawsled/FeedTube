import puppeteer from 'puppeteer-core';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootReal = join(dirname(fileURLToPath(import.meta.url)), '..');
const extPath = join(rootReal, '.output', 'chrome-mv3');

const browser = await puppeteer.launch({
  executablePath:
    'C:\\Users\\pttx\\.cache\\puppeteer\\chrome\\win64-152.0.7977.54\\chrome-win64\\chrome.exe',
  headless: true,
  args: [
    `--disable-extensions-except=${extPath}`,
    `--load-extension=${extPath}`,
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

  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(`[console.${m.type()}] ${m.text().slice(0, 250)}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  page.on('response', (r) => {
    const u = r.url();
    if (/youtube\.com/.test(u)) {
      logs.push(`[http ${r.status()}] ${r.request().method()} ${u.slice(0, 120)}`);
    }
  });
  page.on('requestfailed', (r) =>
    logs.push(`[reqfail] ${r.url().slice(0, 120)} :: ${r.failure()?.errorText}`),
  );
  page.on('dialog', async (d) => {
    logs.push(`[dialog] ${d.message()}`);
    await d.dismiss();
  });

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
              resolve(g.result.map((c) => ({ id: c.id, name: c.name, err: c.lastError })));
            };
          };
        }),
    );

  async function attempt(label, text) {
    console.log(`\n=== add "${text}" (${label}) ===`);
    await page.goto(`chrome-extension://${extId}/dashboard.html#/subs`, { waitUntil: 'load' });
    await sleep(600);
    await page.waitForSelector('input[placeholder*="Channel"]');
    await page.type('input[placeholder*="Channel"]', text);
    await sleep(400);
    // click ONLY the Add button inside <main>
    const clicked = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('main button')];
      const add = btns.find((b) => b.textContent.trim().includes('Add'));
      if (!add || add.disabled) return `not found or disabled (${btns.map((b) => b.textContent.trim())})`;
      add.click();
      return 'clicked';
    });
    console.log(clicked);
    for (let i = 0; i < 10; i++) {
      await sleep(1500);
      const chans = await readChannels();
      if (chans.length > 0) {
        console.log(`ADDED after ~${(i + 1) * 1.5}s:`, JSON.stringify(chans));
        return;
      }
    }
    const bodyText = await page.evaluate(() => document.body.innerText);
    console.log('NOT added. page text:', bodyText.split('\n').filter(Boolean).slice(0, 14).join(' | '));
  }

  await attempt('raw id', 'UCsBjURrPoezykLs9EqgamOA');
  await attempt('handle url', 'https://www.youtube.com/@LinusTechTips');
  await attempt('bare handle', '@mkbhd');
  await attempt('c-url', 'https://www.youtube.com/c/MrBeast6000');

  console.log('\n--- logs ---');
  logs.forEach((l) => console.log(l));
} finally {
  await browser.close();
}
