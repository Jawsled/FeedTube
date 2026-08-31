// Random Chrome-on-Windows device profile, modeled on PipePipe's DeviceForger.
// Bilibili risk control expects dm_img* parameters derived from a plausible desktop
// WebGL fingerprint; signed requests without them get -352 (风控校验失败) or an HTML page.

export interface BiliDevice {
  userAgent: string;
  webGlVersionBase64: string;
  rendererInfoBase64: string;
  innerWidth: number;
  innerHeight: number;
}

const WEB_GL_VERSION = 'WebGL 1.0 (OpenGL ES 2.0 Chromium)';

const GPU_CARDS: Array<[string, string]> = [
  ['AMD', 'AMD Radeon(TM) Graphics (0x00001681)'],
  ['AMD', 'AMD Radeon RX 5700 (0x0000731F)'],
  ['AMD', 'AMD Radeon RX 6800 XT (0x000073BF)'],
  ['Intel', 'Intel(R) Iris(R) Xe Graphics (0x000046A8)'],
  ['Intel', 'Intel(R) UHD Graphics (0x00009BC4)'],
  ['NVIDIA', 'NVIDIA GeForce GTX 1050 Ti (0x00001C82)'],
  ['NVIDIA', 'NVIDIA GeForce GTX 1660 SUPER (0x000021C4)'],
  ['NVIDIA', 'NVIDIA GeForce RTX 3060 (0x00002504)'],
  ['NVIDIA', 'NVIDIA GeForce RTX 3070 (0x00002484)'],
  ['NVIDIA', 'NVIDIA GeForce RTX 4070 SUPER (0x00002783)'],
];

function randInt(maxExclusive: number): number {
  return Math.floor(Math.random() * maxExclusive);
}

// Base64 of the raw string with the last two characters dropped, as PipePipe does.
function base64Sub(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).slice(0, -2);
}

function forgeDevice(): BiliDevice {
  const chromiumVersion = randInt(8) + 130; // Chrome 130..137 on Windows x64
  const [vendor, model] = GPU_CARDS[randInt(GPU_CARDS.length)];
  // "ANGLE (%s, %s Direct3D11 vs_5_0 ps_5_0, D3D11)Google Inc. (%s)" with (vendor, gpuWithApi, vendor).
  const renderer = `ANGLE (${vendor}, ${model} Direct3D11 vs_5_0 ps_5_0, D3D11)Google Inc. (${vendor})`;
  return {
    userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromiumVersion}.0.0.0 Safari/537.36`,
    webGlVersionBase64: base64Sub(WEB_GL_VERSION),
    rendererInfoBase64: base64Sub(renderer),
    innerWidth: 1920 - 60 - randInt(60),
    innerHeight: 1080 - 90 - randInt(60),
  };
}

let currentDevice: BiliDevice | null = null;

export function requireBiliDevice(): BiliDevice {
  if (!currentDevice) currentDevice = forgeDevice();
  return currentDevice;
}

export function regenerateBiliDevice(): void {
  currentDevice = forgeDevice();
}

function getWh(width: number, height: number): [number, number, number] {
  const rnd = randInt(114);
  return [2 * width + 2 * height + 3 * rnd, 4 * width - height + rnd, rnd];
}

// scrollTop/scrollLeft are always 0 in PipePipe.
function getOf(): [number, number, number] {
  const rnd = randInt(514);
  return [rnd, 2 * rnd, rnd];
}

export function getDmImgParams(device: BiliDevice): Record<string, string> {
  const wh = getWh(device.innerWidth, device.innerHeight);
  const of = getOf();
  return {
    dm_img_list: '[]',
    dm_img_str: device.webGlVersionBase64,
    dm_cover_img_str: device.rendererInfoBase64,
    dm_img_inter: `{"ds":[],"wh":[${wh.join(',')}],"of":[${of.join(',')}]}`,
  };
}
