// Injected by esbuild `inject` to provide a Buffer polyfill for the browser.
//
// IMPORTANT: the `buffer` npm package (v6.0.3) does NOT implement the
// 'base64url' encoding — it throws "Unknown encoding: base64url".
// @dsh-ssh/dsh-ssh's router.js relies on base64url to encode/decode the
// remote path segment of a placeholder cwd:
//     Buffer.from(path, 'utf8').toString('base64url')
//     Buffer.from(encoded, 'base64url').toString('utf8')
// decodeRemotePath() swallows the throw and returns null, so every remote
// placeholder path silently degraded to { kind: 'local' } in the browser
// while working fine under Node. We therefore patch base64url in here with a
// dependency-free implementation (no btoa/atob, no Node APIs).
import { Buffer as _Buffer } from 'buffer';

const B64URL_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

// Reverse lookup table: charCode -> 6-bit value, -1 for anything invalid.
const B64URL_LOOKUP = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < B64URL_ALPHABET.length; i++) {
    table[B64URL_ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

// Also accept the standard base64 alphabet so callers passing '+/' still work.
B64URL_LOOKUP['+'.charCodeAt(0)] = 62;
B64URL_LOOKUP['/'.charCodeAt(0)] = 63;

function bytesToBase64url(bytes) {
  let out = '';
  const len = bytes.length;
  let i = 0;
  for (; i + 2 < len; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out +=
      B64URL_ALPHABET[(n >>> 18) & 0x3f] +
      B64URL_ALPHABET[(n >>> 12) & 0x3f] +
      B64URL_ALPHABET[(n >>> 6) & 0x3f] +
      B64URL_ALPHABET[n & 0x3f];
  }
  const rest = len - i;
  if (rest === 1) {
    const b0 = bytes[i];
    out += B64URL_ALPHABET[(b0 >>> 2) & 0x3f];
    out += B64URL_ALPHABET[(b0 << 4) & 0x3f];
  } else if (rest === 2) {
    const n = (bytes[i] << 8) | bytes[i + 1];
    out += B64URL_ALPHABET[(n >>> 10) & 0x3f];
    out += B64URL_ALPHABET[(n >>> 4) & 0x3f];
    out += B64URL_ALPHABET[(n << 2) & 0x3f];
  }
  // base64url is unpadded, matching Node's 'base64url' output.
  return out;
}

function base64urlToBytes(text) {
  // Strip padding and whitespace; tolerate both alphabets.
  const clean = String(text).replace(/[\s=]/g, '');
  const bits = clean.length * 6;
  const byteLen = bits >> 3;
  const out = new Uint8Array(byteLen);
  let acc = 0;
  let accBits = 0;
  let pos = 0;
  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i);
    const val = code < 128 ? B64URL_LOOKUP[code] : -1;
    if (val < 0) throw new TypeError('Invalid base64url character');
    acc = (acc << 6) | val;
    accBits += 6;
    if (accBits >= 8) {
      accBits -= 8;
      out[pos++] = (acc >>> accBits) & 0xff;
    }
  }
  return out;
}

// Wrap the polyfill so 'base64url' works while every other encoding keeps its
// original behaviour.
const _origToString = _Buffer.prototype.toString;
_Buffer.prototype.toString = function toString(enc, ...rest) {
  if (enc === 'base64url') return bytesToBase64url(this);
  return _origToString.call(this, enc, ...rest);
};

const _origFrom = _Buffer.from;
_Buffer.from = function from(value, enc, ...rest) {
  if (enc === 'base64url') {
    return _origFrom.call(_Buffer, base64urlToBytes(value));
  }
  return _origFrom.call(_Buffer, value, enc, ...rest);
};

const _origByteLength = _Buffer.byteLength;
_Buffer.byteLength = function byteLength(value, enc, ...rest) {
  if (enc === 'base64url') return base64urlToBytes(value).length;
  return _origByteLength.call(_Buffer, value, enc, ...rest);
};

// Marker so tests can prove the patch (not the raw polyfill) is what ran.
_Buffer._isBase64UrlPatched = true;

globalThis.Buffer = _Buffer;
