import puppeteer from 'puppeteer-core';

const probeExt = process.env.TEMP + '\\dnr-probe';

const browser = await puppeteer.launch({
  executablePath:
    'C:\\Users\\pttx\\.cache\\puppeteer\\chrome\\win64-152.0.7977.54\\chrome-win64\\chrome.exe',
  headless: true,
  args: [
    `--disable-extensions-except=${probeExt}`,
    `--load-extension=${probeExt}`,
    '--no-first-run',
  ],
});
try {
  const t = await browser.waitForTarget(
    (x) => x.type() === 'service_worker' && x.url().startsWith('chrome-extension://'),
    { timeout: 15000 },
  );
  const cdp = await t.createCDPSession();
  await cdp.send('Runtime.enable');
  cdp.on('Runtime.consoleAPICalled', (e) => {
    console.log('[sw]', e.args.map((a) => a.value ?? a.description ?? '').join(' '));
  });
  await new Promise((r) => setTimeout(r, 8000));
} finally {
  await browser.close();
}
