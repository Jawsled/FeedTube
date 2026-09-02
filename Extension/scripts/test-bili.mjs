// Replicates the full pipeline: get buvid3+buvid4 from finger/spi,
// generate a cookie set, then call the signed space endpoint with the
// exact same cookies + WBI signing + headers the extension would use.
async function md5hex(s) {
  const c = await import('crypto');
  return c.createHash('md5').update(s).digest('hex');
}

async function fetchFinger() {
  const res = await fetch('https://api.bilibili.com/x/frontend/finger/spi');
  const date = res.headers.get('date');
  const j = await res.json();
  return { b3: j.data.b_3, b4: j.data.b_4, bnut: Math.floor(new Date(date).getTime() / 1000) };
}

async function hmac(key, msg) {
  const c = await import('crypto');
  return c.createHmac('sha256', key).update(msg).digest('hex');
}

async function fetchBiliTicket(buvid3, buvid4, bnut) {
  const ts = Math.floor(Date.now() / 1000);
  const hexSign = await hmac('XgwSnGZ1p', 'ts' + ts);
  const url = `https://api.bilibili.com/bapis/bilibili.api.ticket.v1.Ticket/GenWebTicket?key_id=ec02&hexsign=${hexSign}&context%5Bts%5D=${ts}&csrf=`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Referer: 'https://www.bilibili.com/',
      Cookie: `buvid3=${buvid3}; buvid4=${buvid4}; b_nut=${bnut}`,
    },
  });
  return res.json();
}

function getMixinKey(imgKey, subKey) {
  const TABLE = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];
  const raw = imgKey + subKey;
  let out = '';
  for (const idx of TABLE) {
    if (idx >= raw.length) continue;
    out += raw.charAt(idx);
    if (out.length >= 32) break;
  }
  return out.slice(0, 32);
}

function makeLsid() {
  const arr = new Uint8Array(32);
  for (let i = 0; i < 32; i++) arr[i] = Math.floor(Math.random() * 256);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase() + '_' + Date.now();
}

function makeFpUuid() {
  const DIGIT = ['1','2','3','4','5','6','7','8','9','A','B','C','D','E','F','10'];
  const t = Date.now() % 100000;
  const arr = new Uint8Array(32);
  for (let i = 0; i < 32; i++) arr[i] = Math.floor(Math.random() * 256);
  const HYPHEN = new Set([9, 13, 17, 21]);
  let result = '';
  for (let i = 0; i < 32; i++) {
    if (HYPHEN.has(i)) result += '-';
    result += DIGIT[arr[i] & 0x0f];
  }
  result += String(t).padStart(5, '0');
  result += 'infoc';
  return result;
}

function makeBuvidFp() {
  const arr = new Uint8Array(16);
  for (let i = 0; i < 16; i++) arr[i] = Math.floor(Math.random() * 256);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function signedFetch(path, params, mixinKey, cookies) {
  const sorted = Object.entries(params).filter(([, v]) => v != null).sort(([a], [b]) => a.localeCompare(b));
  const sortedQuery = sorted.map(([k, v]) => {
    const key = encodeURIComponent(k).replace(/%2F/g, '/');
    const val = encodeURIComponent(String(v)).replace(/%2F/g, '/').replace(/\+/g, '%20');
    return key + '=' + val;
  }).join('&');
  const wts = Math.floor(Date.now() / 1000);
  const toHash = sortedQuery + '&wts=' + wts + mixinKey;
  const w_rid = await md5hex(toHash);
  const finalQuery = sortedQuery + '&wts=' + wts + '&w_rid=' + w_rid;
  const cookieStr = `buvid3=${cookies.buvid3}; buvid4=${cookies.buvid4}; b_nut=${cookies.b_nut}; b_lsid=${cookies.b_lsid}; _uuid=${cookies._uuid}; buvid_fp=${cookies.buvid_fp}; bili_ticket=${cookies.bili_ticket}`;
  const url = `https://api.bilibili.com${path}?${finalQuery}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Referer: 'https://www.bilibili.com/',
      Cookie: cookieStr,
    },
  });
  return res.json();
}

async function main() {
  console.log('=== 1. finger/spi ===');
  const f = await fetchFinger();
  console.log('  buvid3:', f.b3);
  console.log('  buvid4:', f.b4);
  console.log('  b_nut:', f.bnut);

  console.log('\n=== 2. bili ticket ===');
  const t = await fetchBiliTicket(f.b3, f.b4, f.bnut);
  console.log('  code:', t.code, 'msg:', t.message);
  const ticket = t.data?.ticket ?? '';

  const cookies = {
    buvid3: f.b3,
    buvid4: f.b4,
    b_nut: f.bnut,
    b_lsid: makeLsid(),
    _uuid: makeFpUuid(),
    buvid_fp: makeBuvidFp(),
    bili_ticket: ticket,
  };
  console.log('  full cookie set ready');

  const imgKey = '7cd084941338484aae1ad9425b84077c';
  const subKey = '4932caff0ff746eab6f01bf08b70ac45';
  const mixinKey = getMixinKey(imgKey, subKey);
  console.log('  mixin key:', mixinKey);

  console.log('\n=== 3. signed acc/info with all 7 cookies ===');
  const r1 = await signedFetch('/x/space/wbi/acc/info', { mid: 946974, token: '', platform: 'web', web_location: '1550101' }, mixinKey, cookies);
  console.log('  code:', r1.code, 'msg:', r1.message);
  if (r1.data) {
    console.log('  data.mid:', r1.data.mid, 'name:', r1.data.name);
  }
}

main().catch(e => { console.error('error:', e.message); process.exit(1); });
