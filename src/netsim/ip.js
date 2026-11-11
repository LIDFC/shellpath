// Арифметика IPv4.

export function ip2n(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s || '');
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((x) => x > 255)) return null;
  return (p[0] * 16777216 + (p[1] << 16) + (p[2] << 8) + p[3]) >>> 0;
}
export const n2ip = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
export const maskN = (p) => (p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0);
export function inNet(ip, net, p) {
  const a = ip2n(ip);
  const b = ip2n(net);
  return a !== null && b !== null && ((a & maskN(p)) >>> 0) === ((b & maskN(p)) >>> 0);
}
export const netOf = (ip, p) => n2ip((ip2n(ip) & maskN(p)) >>> 0);
export const bcastOf = (ip, p) => n2ip(((ip2n(ip) & maskN(p)) | (~maskN(p) >>> 0)) >>> 0);

/** 255.255.255.192 → 26; не маска → null */
export function mask2p(m) {
  const n = ip2n(m);
  if (n === null) return null;
  let p = 0;
  while (p < 32 && n & (2 ** (31 - p))) p++;
  return maskN(p) === n ? p : null;
}

/** '10.0.0.5/24', '10.0.0.5/255.255.255.0' или '10.0.0.5' (тогда defP) → { ip, p } | null */
export function parseCidr(s, defP = 32) {
  if (!s) return null;
  const [a, b] = s.split('/');
  if (ip2n(a) === null) return null;
  let p = defP;
  if (b !== undefined) {
    if (/^\d+$/.test(b) && +b <= 32) p = +b;
    else {
      p = mask2p(b);
      if (p === null) return null;
    }
  }
  return { ip: a, p };
}
