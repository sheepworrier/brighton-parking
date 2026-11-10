// B&H Parking Finder: map, search, time and the "nearby options" list. No backend, no accounts.
import { evaluate, describeStatus, describeRules, fmtDuration, fmtTime, fmtRelative, dayHint, KIND_LABEL, londonParts, londonWallToInstant, TZ } from './engine.js';
import { nearby, metresToLonLat } from './geo.js';
import { encodeView, decodeView } from './share.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const BRIGHTON = { center: [-0.1372, 50.8225], bbox: [-0.30, 50.78, 0.05, 50.92] };
const TARIFF_NAME = { L: 'Low', M: 'Medium', H: 'High', HS: 'High summer / low winter' };
const TARIFF_COLOR = { L: '#1b9e77', M: '#f2a900', H: '#c0392b', HS: '#7b4fc9' };
const FREE_LATER_HOURS = 12;   // "free from 20:00" is worth showing if it happens within this many hours

// Categories the user can switch on for the map. 'pay' (paid + shared bays, drawn the same) is on by default.
const CATS = {
  pay:     { label: 'Paid & shared',        sources: ['shared', 'paid'] },
  permit:  { label: 'Permit bays',          sources: ['permit'] },
  sy:      { label: 'Single yellow',        sources: ['sy'] },
  limited: { label: 'Free limited waiting', sources: ['limited'] },
  dy:      { label: 'Double yellow',        sources: ['dy'] },
  red:     { label: 'Red routes',           sources: ['red'] },
};
const KIND_CAT = { paid: 'pay', shared: 'pay', permit: 'permit', sy: 'sy', limited: 'limited', dy: 'dy', red: 'red' };
const INSIGHT_CATS = ['permit', 'sy', 'limited'];                 // categories we mine for free options
const LIST_SOURCES = ['paid', 'shared', 'permit', 'limited', 'sy'];

const state = {
  rulesets: null,
  data: {},                 // key -> Promise<FeatureCollection>
  loaded: {},               // key -> FeatureCollection
  when: null,               // Date | null (null = now)
  origin: null,             // {lat, lon, label}
  cats: { pay: true, permit: false, sy: false, limited: false, dy: false, red: false },
  limit: 30,
  seq: 0,
};
const nowOrWhen = () => state.when || new Date();

// A shared link carries the whole view in the hash: search, planned time, categories and map position.
const shared = decodeView(location.hash, new Date(), Object.keys(CATS));
if (shared.cats) Object.assign(state.cats, shared.cats);
if (shared.when) state.when = shared.when;
if (shared.origin) { state.origin = shared.origin; state.q = shared.q || ''; }
let booted = false;
let hashTimer = null;
function writeHash() {
  if (!booted) return;
  const c = map.getCenter();
  const h = encodeView({ q: state.q, origin: state.origin, when: state.when, cats: state.cats, map: { lat: c.lat, lon: c.lng, zoom: map.getZoom() } });
  // only worth a URL once there is something to share; the bare page stays clean
  const hasView = state.origin || h.includes('c=') || h.includes('t=');
  try { history.replaceState(null, '', hasView ? `#${h}` : location.pathname + location.search); } catch { /* sandboxed */ }
}
const writeHashSoon = () => { clearTimeout(hashTimer); hashTimer = setTimeout(writeHash, 400); };

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
  center: shared.map ? [shared.map.lon, shared.map.lat] : BRIGHTON.center, zoom: shared.map ? shared.map.zoom : 13.2, maxBounds: [[-0.45, 50.70], [0.20, 51.0]],
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
const marker = new maplibregl.Marker({ color: '#14305a', draggable: true });
marker.on('dragend', () => { state.q = ''; const l = marker.getLngLat(); setOrigin({ lat: l.lat, lon: l.lng, label: 'dropped pin' }, { move: false }); });

const tariffColor = ['match', ['get', 't'], 'L', TARIFF_COLOR.L, 'M', TARIFF_COLOR.M, 'H', TARIFF_COLOR.H, 'HS', TARIFF_COLOR.HS, '#8a94a0'];
const zoomW = (a, b, c) => ['interpolate', ['linear'], ['zoom'], 13.5, a, 16.5, b, 19, c];

// Stack order, bottom to top. Layers are added lazily when their category is first switched on.
const LAYER_SPECS = [
  { id: 'dy-line', cat: 'dy', source: 'dy', type: 'line', minzoom: 15, paint: { 'line-color': '#b8860b', 'line-width': zoomW(0.8, 1.6, 3), 'line-opacity': 0.8 } },
  { id: 'red-line', cat: 'red', source: 'red', type: 'line', minzoom: 13, paint: { 'line-color': '#c1121f', 'line-width': zoomW(1.5, 3, 6) } },
  { id: 'permit-fill', cat: 'permit', source: 'permit', type: 'fill', minzoom: 13.5, paint: { 'fill-color': '#7b4fc9', 'fill-opacity': 0.7 } },
  { id: 'permit-line', cat: 'permit', source: 'permit', type: 'line', minzoom: 13.5, paint: { 'line-color': '#7b4fc9', 'line-width': zoomW(1.6, 2.4, 3) } },
  { id: 'limited-fill', cat: 'limited', source: 'limited', type: 'fill', minzoom: 13.5, paint: { 'fill-color': '#2f7fd1', 'fill-opacity': 0.7 } },
  { id: 'limited-line', cat: 'limited', source: 'limited', type: 'line', minzoom: 13.5, paint: { 'line-color': '#2f7fd1', 'line-width': zoomW(1.6, 2.4, 3) } },
  // paid and shared bays look identical; colour is the tariff
  { id: 'shared-fill', cat: 'pay', source: 'shared', type: 'fill', minzoom: 13.5, paint: { 'fill-color': tariffColor, 'fill-opacity': 0.95 } },
  { id: 'shared-line', cat: 'pay', source: 'shared', type: 'line', minzoom: 13.5, paint: { 'line-color': tariffColor, 'line-width': zoomW(2.2, 3.4, 4.5) } },
  { id: 'paid-fill', cat: 'pay', source: 'paid', type: 'fill', minzoom: 13.5, paint: { 'fill-color': tariffColor, 'fill-opacity': 0.95 } },
  { id: 'paid-line', cat: 'pay', source: 'paid', type: 'line', minzoom: 13.5, paint: { 'line-color': tariffColor, 'line-width': zoomW(2.2, 3.4, 4.5) } },
  { id: 'sy-line', cat: 'sy', source: 'sy', type: 'line', minzoom: 14, paint: { 'line-color': '#e0b000', 'line-width': zoomW(2, 3.5, 5), 'line-dasharray': [2, 1] } },
];
const mapReady = new Promise((res) => map.on('load', res));

function addSource(key) {
  if (map.getSource(key)) return;
  map.addSource(key, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  loadData(key).then((g) => map.getSource(key)?.setData(g)).catch((e) => console.error(e));
}

/** Make sure the layers for a category exist and are shown or hidden. */
async function applyCat(cat) {
  await mapReady;
  const on = state.cats[cat];
  if (on) {
    LAYER_SPECS.forEach((spec, i) => {
      if (spec.cat !== cat || map.getLayer(spec.id)) return;
      addSource(spec.source);
      const before = LAYER_SPECS.slice(i + 1).find((s) => map.getLayer(s.id))?.id ?? 'hl-glow';
      const { id, source, type, minzoom, paint } = spec;
      map.addLayer({ id, source, type, minzoom, paint, ...(type === 'line' ? { layout: { 'line-join': 'round' } } : {}) }, before);
    });
  }
  for (const spec of LAYER_SPECS) if (spec.cat === cat && map.getLayer(spec.id)) map.setLayoutProperty(spec.id, 'visibility', on ? 'visible' : 'none');
  const chip = document.querySelector(`.chip.cat[data-cat="${cat}"]`);
  chip?.classList.toggle('on', on);
  chip?.setAttribute('aria-pressed', String(on));
  document.querySelectorAll(`.cathead[data-cat="${cat}"] .cb`).forEach((n) => (n.textContent = on ? 'Hide on map' : 'Show all on map'));
}
function setCat(cat, on) { state.cats[cat] = on; writeHashSoon(); return applyCat(cat); }

map.on('load', () => {
  map.addSource('hl', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'hl-glow', type: 'line', source: 'hl', paint: { 'line-color': '#ffffff', 'line-width': 9, 'line-opacity': 0.95 } });
  map.addLayer({ id: 'hl-line', type: 'line', source: 'hl', paint: { 'line-color': '#14305a', 'line-width': 4 } });
  for (const c of Object.keys(CATS)) applyCat(c);
});

map.on('click', (e) => {
  const pad = 9;
  const layers = LAYER_SPECS.map((s) => s.id).filter((id) => map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== 'none');
  if (!layers.length) return;
  const hits = map.queryRenderedFeatures([[e.point.x - pad, e.point.y - pad], [e.point.x + pad, e.point.y + pad]], { layers });
  if (!hits.length) return;
  const order = ['paid', 'shared', 'limited', 'permit', 'sy', 'red', 'dy'];
  hits.sort((a, b) => order.indexOf(a.properties.k) - order.indexOf(b.properties.k));
  showPopup(hits[0].properties, e.lngLat);
});

// ---------- status helpers ----------
function evalProps(p, when = nowOrWhen()) {
  const ev = evaluate({ k: p.k, r: p.r }, state.rulesets, when);
  return { ev, text: describeStatus(p.k, ev, when, { rel: true }) };
}

/** Status line for a free-option row. Limited waiting is free but time-limited, so say so. */
function optionText(p, ev, when) {
  if (p.k === 'limited') {
    const lim = [p.ms != null ? `max ${fmtDuration(p.ms)}` : null, p.nr != null ? `no return ${fmtDuration(p.nr)}` : null].filter(Boolean).join(', ');
    if (ev.status === 'limited') return `Free${lim ? `, ${lim}` : ''}${ev.next ? `, until ${fmtTime(ev.next.at)}${dayHint(ev.next.at, when)}, then no limit` : ''}`;
    return `Free, no time limit now${ev.next ? `; limit starts ${fmtTime(ev.next.at)}${dayHint(ev.next.at, when)}` : ''}${lim ? ` (${lim})` : ''}`;
  }
  return describeStatus(p.k, ev, when, { rel: true });
}

async function showPopup(p, lngLat) {
  await rulesReady;
  const { text } = evalProps(p);
  const rows = [];
  if (p.z) rows.push(['Zone', p.z]);
  if (p.t) rows.push(['Tariff', TARIFF_NAME[p.t]]);
  if (p.ms != null) rows.push(['Max stay', fmtDuration(p.ms)]);
  if (p.nr != null) rows.push(['No return', `within ${fmtDuration(p.nr)}`]);
  rows.push(['Restricted', p.r >= 0 ? describeRules(state.rulesets[p.r]) : 'Hours unknown']);
  if (p.p) rows.push(['Pay by phone', p.p]);
  const html = `<h3>${esc(p.k === 'shared' ? 'Paid bay (shared with permit holders)' : KIND_LABEL[p.k] || p.k)}</h3>
    <div class="st">${esc(text)}</div>
    <dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
    <div class="warn">Check the signs: suspensions and temporary orders aren't in the data.</div>`;
  setSheet('peek');
  map.easeTo({ center: lngLat, padding: { bottom: sheetPx() } });
  new maplibregl.Popup({ maxWidth: '280px', offset: 6 }).setLngLat(lngLat).setHTML(html).addTo(map);
}

// ---------- nearby list ----------
const clusterKey = (f) => { const p = f.properties; return [KIND_CAT[p.k] === 'pay' ? 'pay' : p.k, p.z, p.r, p.t, p.ms, p.nr].join('|'); };
const clearList = () => $('#results').querySelectorAll('.row, .note, .count, .pick, .hint, .sect').forEach((n) => n.remove());
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };

async function refresh() {
  const seq = ++state.seq;
  if (!state.origin) return;
  clearList();
  $('#results').prepend(el('p', 'note', 'Loading bays…'));
  await rulesReady;
  await Promise.all(LIST_SOURCES.map(loadData));
  if (seq !== state.seq) return;
  clearList();

  const when = nowOrWhen();
  const featsOf = (cat) => CATS[cat].sources.flatMap((k) => state.loaded[k]?.features ?? []);
  const evalCluster = (c) => {
    const p = c.items[0].f.properties;
    return { c, p, ev: evaluate({ k: p.k, r: p.r }, state.rulesets, when) };
  };
  const build = (radius) => ({
    radius,
    pay: nearby(featsOf('pay'), state.origin, radius, clusterKey, 50).map(evalCluster),
    ...Object.fromEntries(INSIGHT_CATS.map((c) => [c, nearby(featsOf(c), state.origin, radius, clusterKey, 50).map(evalCluster)])),
  });
  let res = build(600);
  if (res.pay.length < 4) res = build(1000);

  // chip counts
  for (const cat of Object.keys(CATS)) {
    const chip = document.querySelector(`.chip.cat[data-cat="${cat}"]`);
    if (chip && res[cat]) chip.textContent = `${CATS[cat].label} · ${res[cat].length}`;
  }

  const whenTxt = state.when ? chipFmt.format(when) : 'now';
  const frag = document.createDocumentFragment();
  frag.append(el('p', 'count', `${res.pay.length} paid &amp; shared option${res.pay.length === 1 ? '' : 's'} within ${res.radius === 1000 ? '1 km' : '600 m'} of ${esc(state.origin.label)}, at ${esc(whenTxt)}`));
  if (!res.pay.length) frag.append(el('p', 'note', 'No paid or shared bays here. Check the free options below, or search elsewhere.'));
  res.pay.slice(0, state.limit).forEach((r) => frag.append(rowEl(r, 'pay')));
  if (res.pay.length > state.limit) {
    const more = el('button', 'pick', `Show ${Math.min(30, res.pay.length - state.limit)} more (${res.pay.length - state.limit} not shown)`);
    more.type = 'button';
    more.addEventListener('click', () => { state.limit += 30; refresh(); });
    frag.append(more);
  }

  // ---- free options insight ----
  const sections = INSIGHT_CATS.map((cat) => insightSection(cat, res[cat], when)).filter(Boolean);
  if (sections.length) {
    frag.append(el('h3', 'sect', 'Possible free options nearby'));
    frag.append(el('p', 'sect sub', 'Tap a line to see it on the map, or a heading to show them all. Always check the signs.'));
    sections.forEach((s) => frag.append(s));
  }
  $('#results').prepend(frag);
}

/** One category's worth of insight: heading (toggles the category on the map) plus the nearest free / soon-free rows. */
function insightSection(cat, rows, when) {
  if (!rows.length) return null;
  const horizon = when.getTime() + FREE_LATER_HOURS * 3600000;
  const isFreeNow = ({ ev }) => (cat === 'limited' ? ev.status !== 'unknown' : ev.status === 'free');
  const isFreeLater = ({ ev }) => cat !== 'limited' && ev.status !== 'free' && ev.status !== 'unknown' && ev.next?.status === 'free' && ev.next.at.getTime() <= horizon;
  const usable = rows.filter((r) => isFreeNow(r) || isFreeLater(r));
  const freeNow = rows.filter(isFreeNow).length;
  const later = rows.filter(isFreeLater);
  const unknown = rows.filter(({ ev }) => ev.status === 'unknown').length;
  const earliest = later.length ? later.reduce((a, b) => (a.ev.next.at < b.ev.next.at ? a : b)).ev.next.at : null;
  const bits = [];
  if (freeNow) bits.push(`${freeNow} free${cat === 'limited' ? ' (time-limited)' : ' now'}`);
  if (earliest) bits.push(`${later.length} free from ${fmtTime(earliest)}${dayHint(earliest, when)} (${fmtRelative(earliest, when) || 'later'})`);
  if (unknown) bits.push(`${unknown} hours unknown`);
  if (!bits.length) bits.push(`none free in the next ${FREE_LATER_HOURS} hours`);

  const sect = el('div', 'sect cat');
  const on = state.cats[cat];
  const head = el('button', 'cathead', `<span class="ct">${esc(CATS[cat].label)} <small>${rows.length} nearby</small></span><span class="cs">${esc(bits.join(' · '))}</span><span class="cb">${on ? 'Hide on map' : 'Show all on map'}</span>`);
  head.type = 'button'; head.dataset.cat = cat;
  head.addEventListener('click', async () => {
    const next = !state.cats[cat];
    await setCat(cat, next);
    if (next) { setSheet('peek'); fitTo(rows.flatMap((r) => r.c.items.map((i) => i.f))); }
  });
  sect.append(head);
  usable.sort((a, b) => a.c.d - b.c.d).slice(0, 3).forEach((r) => sect.append(rowEl(r, 'opt')));
  if (usable.length > 3) sect.append(el('p', 'note small', `${usable.length - 3} more. Tap the heading to see them all on the map.`));
  return sect;
}

function rowEl({ c, p, ev }, mode) {
  const li = el('div', `row ${mode === 'pay' ? 'pay' : `opt c-${KIND_CAT[p.k]} s-${ev.status}`}`);
  li.tabIndex = 0; li.setAttribute('role', 'button');
  const metres = c.d * 1.25; // street-grid fudge
  const dist = metres >= 1000 ? `~${(metres / 1000).toFixed(1)} km` : `~${Math.max(10, Math.round(metres / 10) * 10)} m`;
  const when = nowOrWhen();
  let title, dotStyle = '';
  if (mode === 'pay') {
    title = p.t ? `${TARIFF_NAME[p.t]} tariff` : 'Paid bay';
    dotStyle = ` style="background:${TARIFF_COLOR[p.t] || '#8a94a0'}"`;
  } else {
    title = KIND_LABEL[p.k] || p.k;
  }
  if (p.z) title += ` · Zone ${p.z}`;
  const text = mode === 'pay' ? describeStatus(p.k, ev, when, { rel: true }) : optionText(p, ev, when);
  const meta = [];
  if (p.r >= 0) meta.push(describeRules(state.rulesets[p.r]));
  if (mode === 'pay') {
    if (p.ms != null) meta.push(`max ${fmtDuration(p.ms)}`);
    if (p.nr != null) meta.push(`no return ${fmtDuration(p.nr)}`);
  }
  if (c.items.length > 1) meta.push(`${c.items.length} bays`);
  li.innerHTML = `<span class="dot"${dotStyle}></span><div><div class="title">${esc(title)}</div><div class="status">${esc(text)}</div><div class="meta">${esc(meta.join(' · '))}</div></div><div class="dist">${esc(dist)}</div>`;
  const go = () => focusCluster(c);
  li.addEventListener('click', go);
  li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  return li;
}

function boundsOf(features) {
  const b = new maplibregl.LngLatBounds();
  const walk = (c) => (typeof c[0] === 'number' ? b.extend(c) : c.forEach(walk));
  features.forEach((f) => walk(f.geometry.coordinates));
  return b;
}
function fitTo(features) {
  if (!features.length) return;
  map.fitBounds(boundsOf(features), { padding: { top: 70, left: 30, right: 30, bottom: sheetPx() + 10 }, maxZoom: 17.5, duration: 700 });
}

async function focusCluster(c) {
  const cat = KIND_CAT[c.items[0].f.properties.k];
  if (!state.cats[cat]) await setCat(cat, true);
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
  writeHashSoon();
}

const cacheGet = (k) => { try { return JSON.parse(localStorage.getItem('bhpf.geo.' + k)); } catch { return null; } };
const cacheSet = (k, v) => { try { localStorage.setItem('bhpf.geo.' + k, JSON.stringify(v)); } catch { /* private mode etc. */ } };
const POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
const inBrighton = (lat, lon) => lon >= BRIGHTON.bbox[0] && lat >= BRIGHTON.bbox[1] && lon <= BRIGHTON.bbox[2] && lat <= BRIGHTON.bbox[3];

function message(text) {
  clearList();
  $('#results').prepend(el('p', 'note', esc(text)));
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
  state.q = q;
  message('Searching…');
  try {
    const results = await geocode(q);
    if (!results.length) return message(`Couldn't find "${q}". Try a postcode like BN1 1AA, or a street name.`);
    if (results.length === 1) {
      if (!inBrighton(results[0].lat, results[0].lon)) return message(`"${q}" is outside Brighton & Hove.`);
      return setOrigin(results[0]);
    }
    clearList();
    const frag = document.createDocumentFragment();
    frag.append(el('p', 'count', 'Which one?'));
    for (const r of results) {
      const b = el('button', 'pick', esc(r.label)); b.type = 'button';
      b.addEventListener('click', () => setOrigin(r));
      frag.append(b);
    }
    $('#results').prepend(frag);
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
      state.q = '';
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
function setWhen(d) { state.when = d; writeHashSoon(); renderChip(); panel.hidden = true; chip.setAttribute('aria-expanded', 'false'); if (state.origin) refresh(); }
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

// ---------- category chips (what the map shows) ----------
$('#chips').addEventListener('click', (e) => {
  const b = e.target.closest('.chip.cat');
  if (b) setCat(b.dataset.cat, !state.cats[b.dataset.cat]);
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

// ---------- sharing ----------
let toastTimer = null;
function toast(text) {
  const t = $('#toast');
  t.textContent = text; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}
$('#share').addEventListener('click', async () => {
  booted = true; clearTimeout(hashTimer); writeHash();
  const url = location.href;
  const where = state.origin ? ` near ${state.origin.label}` : '';
  try {
    if (navigator.share) { await navigator.share({ title: 'B&H Parking Finder', text: `Parking${where}`, url }); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(url); toast('Link copied'); }
  catch { toast('Copy the address bar to share this view'); }
});

// ---------- boot from a shared link ----------
renderChip();
if (shared.origin) $('#q').value = shared.q || shared.origin.label;
mapReady.then(() => {
  if (shared.origin) setOrigin(shared.origin, { move: !shared.map });
  booted = true;
  writeHash();
});
map.on('moveend', writeHashSoon);

// ---------- PWA ----------
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// test hook for automation (harmless in production)
window.__bhpf = { state, setOrigin, setWhen, refresh, map, setCat };
