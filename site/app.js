// B&H Parking Finder: map, search, time and the "nearby options" list. No backend, no accounts.
import { evaluate, describeStatus, describeRules, fmtDuration, KIND_LABEL, londonParts, londonWallToInstant, TZ } from './engine.js';
import { nearby, metresToLonLat } from './geo.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const BRIGHTON = { center: [-0.1372, 50.8225], bbox: [-0.30, 50.78, 0.05, 50.92] };
const LIST_LAYERS = ['paid', 'shared', 'permit', 'limited', 'sy'];       // used for the nearby list
const STATUS_ORDER = ['free', 'paid', 'limited', 'permit', 'unknown', 'nopark'];
const TARIFF_NAME = { L: 'Low', M: 'Medium', H: 'High', HS: 'High (summer) / Low (winter)' };

const state = {
  rulesets: null,
  data: {},                 // key -> Promise<FeatureCollection>
  loaded: {},               // key -> FeatureCollection
  when: null,               // Date | null (null = now)
  origin: null,             // {lat, lon, label}
  filters: { free: true, paid: true, limited: true, permit: true, unknown: true, nopark: false },
  clusters: [],
  seq: 0,
  limit: 30,
};

const nowOrWhen = () => state.when || new Date();

// ---------- data ----------
function loadData(key) {
  if (!state.data[key]) {
    state.data[key] = fetch(`data/${key}.geojson`).then((r) => { if (!r.ok) throw new Error(`${key}: HTTP ${r.status}`); return r.json(); })
      .then((g) => (state.loaded[key] = g));
  }
  return state.data[key];
}
const rulesReady = fetch('data/rules.json').then((r) => r.json()).then((r) => (state.rulesets = r));
fetch('data/meta.json').then((r) => r.json()).then((m) => {
  const d = new Date(m.generated);
  $('#dataDate').textContent = `Data refreshed ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: TZ })}.`;
}).catch(() => {});

// ---------- map ----------
const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/positron',
  center: BRIGHTON.center, zoom: 13.2, maxBounds: [[-0.45, 50.70], [0.20, 51.0]],
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
const marker = new maplibregl.Marker({ color: '#c1121f', draggable: true });
marker.on('dragend', () => { const l = marker.getLngLat(); setOrigin({ lat: l.lat, lon: l.lng, label: 'Dropped pin' }, { move: false }); });

const tariffColor = ['match', ['get', 't'], 'L', '#9ecae1', 'M', '#4292c6', 'H', '#08306b', 'HS', '#3182bd', '#4292c6'];
const widen = (a, b) => ['interpolate', ['linear'], ['zoom'], 14, a, 19, b];
const BAY_LAYERS = ['paid-fill', 'shared-fill', 'permit-fill', 'limited-fill', 'sy-line', 'dy-line', 'red-line'];

function addSource(key) {
  if (map.getSource(key)) return;
  map.addSource(key, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  loadData(key).then((g) => map.getSource(key)?.setData(g)).catch((e) => console.error(e));
}

map.on('load', () => {
  for (const k of ['dy', 'red', 'permit', 'limited', 'shared', 'paid', 'sy']) addSource(k);
  map.addSource('hl', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  const L = (def) => map.addLayer(def);
  L({ id: 'dy-line', type: 'line', source: 'dy', minzoom: 15, paint: { 'line-color': '#d9a400', 'line-width': widen(0.8, 2.6), 'line-opacity': 0.55 } });
  L({ id: 'red-line', type: 'line', source: 'red', minzoom: 13, paint: { 'line-color': '#c1121f', 'line-width': widen(1.5, 5) } });
  L({ id: 'permit-fill', type: 'fill', source: 'permit', minzoom: 13.5, paint: { 'fill-color': '#f08a24', 'fill-opacity': 0.75 } });
  L({ id: 'permit-line', type: 'line', source: 'permit', minzoom: 13.5, paint: { 'line-color': '#b45f00', 'line-width': widen(1.2, 1.6) } });
  L({ id: 'limited-fill', type: 'fill', source: 'limited', minzoom: 13.5, paint: { 'fill-color': '#3fa66b', 'fill-opacity': 0.8 } });
  L({ id: 'limited-line', type: 'line', source: 'limited', minzoom: 13.5, paint: { 'line-color': '#1f6f46', 'line-width': widen(1.2, 1.6) } });
  L({ id: 'shared-fill', type: 'fill', source: 'shared', minzoom: 13.5, paint: { 'fill-color': tariffColor, 'fill-opacity': 0.85 } });
  L({ id: 'shared-line', type: 'line', source: 'shared', minzoom: 13.5, paint: { 'line-color': '#e8710a', 'line-width': widen(1.4, 2.2) } });
  L({ id: 'paid-fill', type: 'fill', source: 'paid', minzoom: 13.5, paint: { 'fill-color': tariffColor, 'fill-opacity': 0.9 } });
  L({ id: 'paid-line', type: 'line', source: 'paid', minzoom: 13.5, paint: { 'line-color': '#0b2a57', 'line-width': widen(1.2, 1.8) } });
  L({ id: 'sy-line', type: 'line', source: 'sy', minzoom: 14, paint: { 'line-color': '#f2c200', 'line-width': widen(1.8, 4.5), 'line-dasharray': [2, 1] } });
  L({ id: 'hl-glow', type: 'line', source: 'hl', paint: { 'line-color': '#ffffff', 'line-width': 8, 'line-opacity': 0.9 } });
  L({ id: 'hl-line', type: 'line', source: 'hl', paint: { 'line-color': '#c1121f', 'line-width': 3.5 } });
});

map.on('click', (e) => {
  if (!map.getLayer('paid-fill')) return;
  const pad = 9;
  const layers = BAY_LAYERS.filter((l) => map.getLayer(l));
  const hits = map.queryRenderedFeatures([[e.point.x - pad, e.point.y - pad], [e.point.x + pad, e.point.y + pad]], { layers });
  if (!hits.length) return;
  // prefer the most specific (small bays) over lines
  const order = ['paid', 'shared', 'limited', 'permit', 'sy', 'red', 'dy'];
  hits.sort((a, b) => order.indexOf(a.properties.k) - order.indexOf(b.properties.k));
  showPopup(hits[0].properties, e.lngLat);
});
for (const l of BAY_LAYERS) {
  map.on('mouseenter', l, () => (map.getCanvas().style.cursor = 'pointer'));
  map.on('mouseleave', l, () => (map.getCanvas().style.cursor = ''));
}

// ---------- status helpers ----------
function evalProps(p, when = nowOrWhen()) {
  const ev = evaluate({ k: p.k, r: p.r }, state.rulesets, when);
  return { ev, text: describeStatus(p.k, ev, when) };
}

function detailLines(p) {
  const out = [];
  if (p.t) out.push(['Tariff', TARIFF_NAME[p.t]]);
  if (p.ms != null) out.push(['Max stay', fmtDuration(p.ms)]);
  if (p.nr != null) out.push(['No return', `within ${fmtDuration(p.nr)}`]);
  return out;
}

async function showPopup(p, lngLat) {
  await rulesReady;
  const { ev, text } = evalProps(p);
  const rows = [];
  if (p.z) rows.push(['Zone', p.z]);
  rows.push(...detailLines(p));
  rows.push(['Restricted', p.r >= 0 ? describeRules(state.rulesets[p.r]) : 'Hours unknown']);
  if (p.p) rows.push(['Pay by phone', p.p]);
  const html = `<h3>${esc(KIND_LABEL[p.k] || p.k)}</h3>
    <div class="st">${esc(text)}</div>
    <dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
    <div class="warn">Check the signs: suspensions and temporary orders aren't in the data.</div>`;
  setSheet('peek');
  map.easeTo({ center: lngLat, padding: { bottom: sheetPx() } });
  new maplibregl.Popup({ maxWidth: '280px', offset: 6 }).setLngLat(lngLat).setHTML(html).addTo(map);
}

// ---------- nearby list ----------
const clusterKey = (f) => { const p = f.properties; return [p.k, p.z, p.r, p.t, p.ms, p.nr].join('|'); };

async function refresh() {
  const seq = ++state.seq;
  const box = $('#results');
  if (!state.origin) return;
  box.querySelectorAll('.row, .note, .count, .pick').forEach((n) => n.remove());
  const loading = document.createElement('p'); loading.className = 'note'; loading.textContent = 'Loading bays…';
  box.prepend(loading);
  await rulesReady;
  await Promise.all(LIST_LAYERS.map(loadData));
  if (seq !== state.seq) return;
  loading.remove();

  const when = nowOrWhen();
  const feats = LIST_LAYERS.flatMap((k) => state.loaded[k].features);
  let radius = 600;
  let build = () => nearby(feats, state.origin, radius, clusterKey, 50).map((c) => {
    const p = c.items[0].f.properties;
    const { ev, text } = evalProps(p, when);
    return { c, p, ev, text };
  });
  let rows = build();
  const visible = () => rows.filter((r) => state.filters[r.ev.status]);
  if (visible().length < 4) { radius = 1000; rows = build(); }
  const shown = visible().sort((a, b) => a.c.d - b.c.d);
  state.clusters = shown;

  const head = document.createElement('p');
  head.className = 'count';
  const whenTxt = state.when ? new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(when) : 'now';
  head.textContent = `${shown.length} option${shown.length === 1 ? '' : 's'} within ${radius === 1000 ? '1 km' : '600 m'} of ${state.origin.label}, at ${whenTxt}`;
  box.prepend(head);

  const frag = document.createDocumentFragment();
  if (!shown.length) {
    const n = document.createElement('p'); n.className = 'note';
    n.textContent = 'Nothing matches your filters here. Try turning on more filters, or search elsewhere.';
    frag.append(n);
  }
  shown.slice(0, state.limit).forEach((r, i) => frag.append(rowEl(r, i)));
  if (shown.length > state.limit) {
    const more = document.createElement('button'); more.type = 'button'; more.className = 'pick';
    more.textContent = `Show ${Math.min(30, shown.length - state.limit)} more (${shown.length - state.limit} not shown)`;
    more.addEventListener('click', () => { state.limit += 30; refresh(); });
    frag.append(more);
  }
  head.after(frag);
}

function rowEl({ c, p, ev, text }, i) {
  const li = document.createElement('div');
  li.className = `row s-${ev.status}`;
  li.dataset.i = i; li.tabIndex = 0; li.setAttribute('role', 'button');
  const metres = c.d * 1.25; // street-grid fudge
  const dist = metres >= 1000 ? `~${(metres / 1000).toFixed(1)} km` : `~${Math.max(10, Math.round(metres / 10) * 10)} m`;
  let title = KIND_LABEL[p.k] || p.k;
  if (p.z) title = `${title} · Zone ${p.z}`;
  const meta = [];
  if (p.r >= 0) meta.push(describeRules(state.rulesets[p.r]));
  const t = p.t ? `${TARIFF_NAME[p.t]} tariff` : null; if (t) meta.push(t);
  if (p.ms != null) meta.push(`max ${fmtDuration(p.ms)}`);
  if (p.nr != null) meta.push(`no return ${fmtDuration(p.nr)}`);
  if (c.items.length > 1) meta.push(`${c.items.length} bays`);
  li.innerHTML = `<span class="dot"></span><div><div class="title">${esc(title)}</div><div class="status">${esc(text)}</div><div class="meta">${esc(meta.join(' · '))}</div></div><div class="dist">${esc(dist)}</div>`;
  const go = () => focusCluster(c);
  li.addEventListener('click', go);
  li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  return li;
}

function focusCluster(c) {
  map.getSource('hl')?.setData({ type: 'FeatureCollection', features: c.items.map((x) => x.f) });
  const [lon, lat] = metresToLonLat(state.origin, c.nx, c.ny);
  setSheet('peek');
  map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 17.5), padding: { bottom: sheetPx() } });
}

// ---------- origin / search ----------
function setOrigin(o, { move = true } = {}) {
  state.origin = o;
  state.limit = 30;
  marker.setLngLat([o.lon, o.lat]).addTo(map);
  map.getSource('hl')?.setData({ type: 'FeatureCollection', features: [] });
  if (move) map.flyTo({ center: [o.lon, o.lat], zoom: 16.5, padding: { bottom: Math.round(window.innerHeight * 0.45) } });
  if ($('#sheet').dataset.state === 'peek') setSheet('half');
  refresh();
}

const cacheGet = (k) => { try { return JSON.parse(localStorage.getItem('bhpf.geo.' + k)); } catch { return null; } };
const cacheSet = (k, v) => { try { localStorage.setItem('bhpf.geo.' + k, JSON.stringify(v)); } catch { /* private mode etc. */ } };
const POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
const inBrighton = (lat, lon) => lon >= BRIGHTON.bbox[0] && lat >= BRIGHTON.bbox[1] && lon <= BRIGHTON.bbox[2] && lat <= BRIGHTON.bbox[3];

function message(text) {
  const box = $('#results');
  box.querySelectorAll('.row, .note, .count, .pick').forEach((n) => n.remove());
  const p = document.createElement('p'); p.className = 'note'; p.textContent = text;
  box.prepend(p);
  if ($('#sheet').dataset.state === 'peek') setSheet('half');
}

async function geocode(q) {
  const key = q.trim().toLowerCase();
  const hit = cacheGet(key);
  if (hit) return hit;
  let results = [];
  if (POSTCODE.test(q.trim())) {
    const r = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(q.trim())}`);
    if (r.ok) { const j = (await r.json()).result; results = [{ lat: j.latitude, lon: j.longitude, label: j.postcode }]; }
  } else {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=gb&bounded=1&viewbox=${BRIGHTON.bbox[0]},${BRIGHTON.bbox[3]},${BRIGHTON.bbox[2]},${BRIGHTON.bbox[1]}&q=${encodeURIComponent(q)}`;
    const r = await fetch(url);
    if (r.ok) results = (await r.json()).map((x) => ({ lat: +x.lat, lon: +x.lon, label: x.display_name.split(',').slice(0, 2).join(',').trim() }));
  }
  if (results.length) cacheSet(key, results);
  return results;
}

$('#searchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#q').value.trim();
  if (!q) return;
  $('#q').blur();
  message('Searching…');
  try {
    const results = await geocode(q);
    if (!results.length) return message(`Couldn't find "${q}". Try a postcode like BN1 1AA, or a street name.`);
    if (results.length === 1) {
      if (!inBrighton(results[0].lat, results[0].lon)) return message(`"${q}" is outside Brighton & Hove.`);
      return setOrigin(results[0]);
    }
    const box = $('#results');
    box.querySelectorAll('.row, .note, .count, .pick').forEach((n) => n.remove());
    const frag = document.createDocumentFragment();
    const n = document.createElement('p'); n.className = 'count'; n.textContent = 'Which one?'; frag.append(n);
    for (const r of results) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'pick'; b.textContent = r.label;
      b.addEventListener('click', () => setOrigin(r));
      frag.append(b);
    }
    box.prepend(frag);
    setSheet('half');
  } catch (err) {
    console.error(err);
    message('Search failed. Check your connection and try again.');
  }
});

$('#locate').addEventListener('click', () => {
  if (!navigator.geolocation) return message('Location isn\'t available on this device.');
  message('Finding you…');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const o = { lat: pos.coords.latitude, lon: pos.coords.longitude, label: 'your location' };
      if (!inBrighton(o.lat, o.lon)) return message('You seem to be outside Brighton & Hove. Search a postcode instead.');
      setOrigin(o);
    },
    () => message('Couldn\'t get your location. Allow location access, or search a postcode.'),
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
});

// ---------- time chip ----------
const chip = $('#timeChip'), panel = $('#timePanel');
const chipFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
function renderChip() { chip.textContent = state.when ? chipFmt.format(state.when) : 'Now'; }
function setWhen(d) { state.when = d; renderChip(); panel.hidden = true; chip.setAttribute('aria-expanded', 'false'); if (state.origin) refresh(); }
chip.addEventListener('click', () => { panel.hidden = !panel.hidden; chip.setAttribute('aria-expanded', String(!panel.hidden)); });
panel.addEventListener('click', (e) => {
  const p = e.target.closest('button')?.dataset.p;
  if (!p) return;
  const now = new Date(), lp = londonParts(now);
  const at = (days, hh) => { const d = new Date(Date.UTC(lp.y, lp.m - 1, lp.d + days)); return londonWallToInstant(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), hh * 60); };
  if (p === 'now') setWhen(null);
  else if (p === 'plus1') setWhen(new Date(now.getTime() + 3600000));
  else if (p === 'tonight') { let t = at(0, 19); if (t <= now) t = at(1, 19); setWhen(t); }
  else if (p === 'tomorrow') setWhen(at(1, 9));
});
$('#dt').addEventListener('change', (e) => {
  const m = e.target.value.match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)/);
  if (m) setWhen(londonWallToInstant(+m[1], +m[2], +m[3], +m[4] * 60 + +m[5]));
});
setInterval(() => { if (!state.when && state.origin && !document.hidden) refresh(); }, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && !state.when && state.origin) refresh(); });

// ---------- filters ----------
$('#chips').addEventListener('click', (e) => {
  const b = e.target.closest('.chip.f');
  if (!b) return;
  const f = b.dataset.f;
  state.filters[f] = !state.filters[f];
  b.classList.toggle('on', state.filters[f]);
  if (state.origin) refresh();
});

// ---------- bottom sheet ----------
const sheet = $('#sheet');
const STATES = ['peek', 'half', 'full'];
function setSheet(s) { sheet.dataset.state = s; }
function sheetPx() { return Math.round(sheet.getBoundingClientRect().height) + 8; }
const grab = $('#grab');
let drag = null;
grab.addEventListener('pointerdown', (e) => { drag = { y: e.clientY, moved: false }; grab.setPointerCapture(e.pointerId); });
grab.addEventListener('pointermove', (e) => { if (drag && Math.abs(e.clientY - drag.y) > 6) drag.moved = true; });
grab.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const dy = e.clientY - drag.y, i = STATES.indexOf(sheet.dataset.state);
  if (!drag.moved) setSheet(STATES[(i + 1) % 3]);
  else if (dy < -30) setSheet(STATES[Math.min(2, i + 1)]);
  else if (dy > 30) setSheet(STATES[Math.max(0, i - 1)]);
  drag = null;
});
grab.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSheet(STATES[(STATES.indexOf(sheet.dataset.state) + 1) % 3]); } });
$('#q').addEventListener('focus', () => { if (sheet.dataset.state === 'full') setSheet('half'); });

// ---------- PWA ----------
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// test hook for automation (harmless in production)
window.__bhpf = { state, setOrigin, setWhen, refresh, map };
