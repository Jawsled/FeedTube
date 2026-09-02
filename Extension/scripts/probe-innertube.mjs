const BASE = 'https://www.youtube.com/youtubei/v1/browse?prettyPrint=false';
const CHANNEL = 'UCsBjURrPoezykLs9EqgamOA';
const PARAMS_VIDEOS = 'EgZ2aWRlb3PyBgQKAjoA';

const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

async function probe(label, client, extraHeaders, params = PARAMS_VIDEOS) {
  const body = {
    context: { client },
    browseId: CHANNEL,
    params,
  };
  try {
    const res = await fetch(BASE, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    });
    const text = res.status === 200 ? '' : (await res.text()).slice(0, 160);
    let shape = '';
    if (res.ok) {
      const j = await res.json();
      const raw = JSON.stringify(j);
      const lockup = raw.includes('lockupViewModel');
      const vr = raw.includes('videoRenderer');
      const rich = raw.includes('richItemRenderer');
      const meta = j?.metadata?.channelMetadataRenderer?.title;
      shape = `title=${meta} richItem=${rich} lockup=${lockup} videoRenderer=${vr}`;
    }
    console.log(`${res.status === 200 ? 'OK  ' : 'ERR '} ${label} :: ${res.status} ${shape} ${text}`);
    return res.status === 200;
  } catch (e) {
    console.log(`THRW ${label} :: ${e.message}`);
    return false;
  }
}

console.log('--- simulating browser Origin ---');

await probe(
  'WEB + ext Origin',
  { clientName: 'WEB', clientVersion: '2.20260818.01.00', hl: 'en', gl: 'US' },
  { Origin: EXT_ORIGIN },
);

await probe(
  'WEB + ext Origin + X-Goog-Api-Origin',
  { clientName: 'WEB', clientVersion: '2.20260818.01.00', hl: 'en', gl: 'US' },
  { Origin: EXT_ORIGIN, 'X-Goog-Api-Origin': 'https://www.youtube.com', 'X-Origin': 'https://www.youtube.com' },
);

await probe(
  'ANDROID + ext Origin',
  {
    clientName: 'ANDROID',
    clientVersion: '19.09.37',
    androidSdkVersion: 30,
    hl: 'en',
    gl: 'US',
  },
  {
    Origin: EXT_ORIGIN,
    'User-Agent':
      'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip',
    'X-Youtube-Client-Name': '3',
    'X-Youtube-Client-Version': '19.09.37',
  },
);

await probe(
  'IOS + ext Origin',
  {
    clientName: 'IOS',
    clientVersion: '19.09.3',
    deviceModel: 'iPhone14,3',
    hl: 'en',
    gl: 'US',
  },
  {
    Origin: EXT_ORIGIN,
    'User-Agent': 'com.google.ios.youtube/19.09.3 (iPhone14,3; U; CPU iOS 15_6 like Mac OS X)',
    'X-Youtube-Client-Name': '5',
    'X-Youtube-Client-Version': '19.09.3',
  },
);

await probe(
  'WEB_EMBEDDED_PLAYER + ext Origin',
  { clientName: 'WEB_EMBEDDED_PLAYER', clientVersion: '1.20260818.01.00', hl: 'en', gl: 'US' },
  { Origin: EXT_ORIGIN },
);
