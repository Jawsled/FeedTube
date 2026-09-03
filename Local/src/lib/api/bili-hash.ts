// Tiny pure-JS SHA-1. We can't rely on crypto.subtle.digest('SHA-1', …): Chrome
// is in the process of deprecating SHA-1 from SubtleCrypto, and some sandboxed
// environments (and the test harness) don't expose it. The implementation below
// is the standard FIPS-180-4 algorithm and matches every standard test vector.

function rol(n: number, b: number): number {
  return (n << b) | (n >>> (32 - b));
}

export function sha1Hex(message: string | Uint8Array): string {
  const bytes = typeof message === 'string' ? new TextEncoder().encode(message) : message;
  const len = bytes.length;
  // Padded length is 1 '1' bit + 8 length bytes + the message, rounded up to 64 bytes.
  const wordLen = Math.max(1, Math.ceil((len + 9) / 64)) * 16;
  const words = new Uint32Array(wordLen);
  for (let i = 0; i < len; i++) words[i >> 2] |= bytes[i] << ((3 - (i & 3)) * 8);
  words[len >> 2] |= 0x80 << ((3 - (len & 3)) * 8);
  words[wordLen - 1] = len * 8;

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  for (let i = 0; i < words.length; i += 16) {
    const w = new Uint32Array(80);
    for (let j = 0; j < 16; j++) w[j] = words[i + j]!;
    for (let j = 16; j < 80; j++) {
      w[j] = rol(w[j - 3]! ^ w[j - 8]! ^ w[j - 14]! ^ w[j - 16]!, 1);
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let j = 0; j < 80; j++) {
      let f: number, k: number;
      if (j < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (j < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (j < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const t = (rol(a, 5) + f + e + k + w[j]!) | 0;
      e = d; d = c; c = rol(b, 30); b = a; a = t;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }

  const toHex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
  return toHex(h0) + toHex(h1) + toHex(h2) + toHex(h3) + toHex(h4);
}
