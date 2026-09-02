// Browser shim for node:path — only the subset used by @dsh-ssh/dsh-ssh/src/router.js
// In the browser, placeholder paths use '/' separator (POSIX-style).
const sep = '/';
export function resolve(...segments) {
  let result = '';
  for (const seg of segments) {
    if (seg.startsWith('/')) { result = seg; continue; }
    result = result ? result.replace(/\/+$/, '') + '/' + seg : seg;
  }
  // Normalize: collapse //, resolve . and ..
  const parts = result.split('/').filter(Boolean);
  const out = [];
  for (const p of parts) {
    if (p === '.') continue;
    if (p === '..') { out.pop(); continue; }
    out.push(p);
  }
  return '/' + out.join('/');
}
export function join(...segments) {
  return resolve(...segments);
}
export function relative(from, to) {
  const fromParts = resolve(from).split('/').filter(Boolean);
  const toParts = resolve(to).split('/').filter(Boolean);
  let common = 0;
  while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) common++;
  const ups = fromParts.length - common;
  const downs = toParts.slice(common);
  const segs = [...Array(ups).fill('..'), ...downs];
  return segs.join('/') || '.';
}
export function isAbsolute(p) {
  return typeof p === 'string' && p.startsWith('/');
}
export function basename(p, ext) {
  let base = p.split('/').pop() || '';
  if (ext && base.endsWith(ext)) base = base.slice(0, -ext.length);
  return base;
}
export function dirname(p) {
  const idx = p.lastIndexOf('/');
  return idx > 0 ? p.slice(0, idx) : '/';
}
export const posix = { resolve, join, relative, isAbsolute, basename, dirname, sep };
export default { resolve, join, relative, isAbsolute, basename, dirname, sep, posix };
