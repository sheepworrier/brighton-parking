// Encode / decode the shareable view in the URL hash. Pure functions, no DOM.
// Example: #q=Unithai&ll=50.82735,-0.15208&l=Unithai&t=2026-11-10T19:00Z&c=pay,permit&v=50.8273,-0.1521,16.5
export const DEFAULT_CATS = ['pay'];
const enc = encodeURIComponent;
const r = (n, dp) => Number(n).toFixed(dp);

/** view: {q, origin:{lat,lon,label}, when:Date|null, cats:{name:boolean}, map:{lat,lon,zoom}} -> hash string without '#' */
export function encodeView({ q, origin, when, cats, map } = {}) {
  const parts = [];
  if (q) parts.push(`q=${enc(String(q).slice(0, 100))}`);
  if (origin) {
    parts.push(`ll=${r(origin.lat, 5)},${r(origin.lon, 5)}`);
    const label = origin.label === 'your location' ? 'a location' : origin.label;
    if (label) parts.push(`l=${enc(String(label).slice(0, 80))}`);
  }
  if (when) parts.push(`t=${when.toISOString().slice(0, 16)}Z`);
  const on = Object.keys(cats || {}).filter((k) => cats[k]);
  if (on.join(',') !== DEFAULT_CATS.join(',')) parts.push(`c=${on.length ? on.join(',') : 'none'}`);
  if (map) parts.push(`v=${r(map.lat, 4)},${r(map.lon, 4)},${r(map.zoom, 1)}`);
  return parts.join('&');
}

const num = (s) => (s !== '' && Number.isFinite(+s) ? +s : NaN);
const inArea = (lat, lon) => lat >= 50.5 && lat <= 51.3 && lon >= -0.8 && lon <= 0.5;   // sanity bounds around Brighton

/** hash (with or without '#') -> {q, origin, when, cats, map}; anything missing or invalid is simply absent. */
export function decodeView(hash, now = new Date(), validCats = []) {
  const out = {};
  const raw = String(hash || '').replace(/^#/, '');
  if (!raw) return out;
  const p = {};
  for (const kv of raw.split('&')) {
    const i = kv.indexOf('=');
    if (i < 1) continue;
    try { p[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1).replace(/\+/g, ' ')); } catch { /* skip malformed */ }
  }
  if (p.q) out.q = p.q.slice(0, 100);
  if (p.ll) {
    const [lat, lon] = p.ll.split(',').map(num);
    if (inArea(lat, lon)) out.origin = { lat, lon, label: (p.l || p.q || 'shared location').slice(0, 80) };
  }
  if (p.t) {
    const d = new Date(p.t);
    // a link shared yesterday with "tonight 19:00" shouldn't open in the past
    if (!Number.isNaN(d.getTime()) && d.getTime() >= now.getTime() - 10 * 60000 && d.getTime() < now.getTime() + 60 * 86400000) out.when = d;
  }
  if (p.c != null) {
    const names = p.c === 'none' ? [] : p.c.split(',').filter((c) => validCats.includes(c));
    out.cats = Object.fromEntries(validCats.map((c) => [c, names.includes(c)]));
  }
  if (p.v) {
    const [lat, lon, zoom] = p.v.split(',').map(num);
    if (inArea(lat, lon) && zoom >= 8 && zoom <= 21) out.map = { lat, lon, zoom };
  }
  return out;
}
