// Raw council GeoJSON -> compact, normalised site data in .cache/out (validate.mjs publishes it).
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { LAYERS, COORD_DP, SIMPLIFY_TOL } from './lib/config.mjs';
import * as P from './lib/parse.mjs';
import { cleanGeometry } from './lib/geom.mjs';
import { bngToLonLat } from './lib/bng.mjs';

import { entriesKey } from './lib/tro.mjs';
import { buildIndex, toXY, alignment, samplePoints } from './lib/snap.mjs';
const root = new URL('../', import.meta.url);
const raw = (f) => new URL(`.cache/raw/${f}`, root);
const out = new URL('.cache/out/', root);
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const typos = JSON.parse(await readFile(new URL('data-src/typos.json', root), 'utf8'));

// overrides.csv: layer,objectid,field,value,reason   (value may contain commas only if quoted; we keep it simple)
const overrides = new Map();
for (const line of (await readFile(new URL('data-src/overrides.csv', root), 'utf8')).split('\n').slice(1)) {
  if (!line.trim()) continue;
  const [layer, oid, field, value] = line.split(',');
  const k = `${layer}:${oid}`;
  if (!overrides.has(k)) overrides.set(k, []);
  overrides.get(k).push({ field, value });
}
const usedOverrides = new Set();

// OSM roads (scripts/osm-roads.mjs): street names + alignment check. Required in CI (REQUIRE_OSM=1).
let roads = null;
try { roads = buildIndex(JSON.parse(gunzipSync(await readFile(new URL('data-src/osm-roads.json.gz', root))).toString()).ways); }
catch { if (process.env.REQUIRE_OSM) throw new Error('data-src/osm-roads.json.gz missing; run node scripts/osm-roads.mjs'); console.warn('No OSM roads: street names and the alignment check are skipped'); }
const streets = [];            // interned street names
const streetIdx = new Map();
const NAMED = new Set(['paid', 'shared', 'permit', 'limited', 'sy', 'red']);
const SNAP_M = 30;
const feats0 = { named: 0, total: 0 };
const midpoint = (g) => {
  let c = g.coordinates;
  if (g.type === 'Polygon') c = c[0]; else if (g.type === 'MultiPolygon') c = c[0][0]; else if (g.type === 'MultiLineString') c = c[0];
  if (g.type === 'LineString' || g.type === 'MultiLineString') return c[Math.floor(c.length / 2)];
  const n = c.length - 1 || 1;            // closed ring: skip duplicate last point
  let x = 0, y = 0;
  for (let i = 0; i < n; i++) { x += c[i][0]; y += c[i][1]; }
  return [x / n, y / n];
};
function streetOf(geometry) {
  if (!roads) return null;
  const [x, y] = toXY(...midpoint(geometry));
  const hit = roads.nearest(x, y, SNAP_M);
  if (!hit) return null;
  if (!streetIdx.has(hit.name)) { streetIdx.set(hit.name, streets.length); streets.push(hit.name); }
  return streetIdx.get(hit.name);
}

const errors = [];
const warnings = [];
const rulesets = [];            // interned
const rsIndex = new Map();
function intern(entries) {
  const sorted = [...entries].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const k = JSON.stringify(sorted);
  if (!rsIndex.has(k)) { rsIndex.set(k, rulesets.length); rulesets.push(sorted); }
  return rsIndex.get(k);
}

// case-insensitive property access (the council mixes Layer/LAYER, Times/TIMES, ZONE/Zone)
const getter = (p) => {
  const lc = {};
  for (const [k, v] of Object.entries(p)) lc[k.toLowerCase()] = v;
  return (k) => lc[k.toLowerCase()];
};

const DAY_COLS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const dayIdx = (s) => { const c = P.clean(s); return c in P.DAY_IDX ? P.DAY_IDX[c] : null; };
const looksLikeTime = (s) => /^\d/.test(P.clean(s));

/** returns {entries} | {unknown: reason}; throws ParseError for present-but-bad strings */
function rulesFromDaysTimes(days, times) {
  if (P.isBlank(days) && P.isBlank(times)) return { unknown: 'missing' };
  const t = P.parseTimes(times, typos);
  if (t === 'always') return { entries: P.ALWAYS };
  if (P.isBlank(days)) return { unknown: 'no-days' };
  return { entries: P.entriesFor(P.parseDays(days, typos), t) };
}

function rulesForSingleYellow(g) {
  const days = g('days'), times = g('times');
  if (!P.isBlank(days) || !P.isBlank(times)) return rulesFromDaysTimes(days, times);
  const df = g('day_from'), dt = g('day_to'), tf = g('time_from'), tt = g('time_to');
  if (P.isBlank(df) && P.isBlank(dt) && P.isBlank(tf) && P.isBlank(tt)) return { unknown: 'all-NA' };
  if ((!P.isBlank(df) && looksLikeTime(df)) || (!P.isBlank(dt) && looksLikeTime(dt))) return { unknown: 'shifted-columns' };
  if (P.isBlank(df) || P.isBlank(dt)) return { unknown: 'no-days' };
  if (P.isBlank(tf) || P.isBlank(tt)) return { unknown: 'no-times' };
  const a = dayIdx(df), b = dayIdx(dt);
  if (a == null || b == null) throw new P.ParseError(`bad DAY_FROM/DAY_TO ${JSON.stringify([df, dt])}`);
  const mask = P.parseDays(`${P.clean(df)} to ${P.clean(dt)}`, typos);
  const windows = [P.parseTimes(`${tf} to ${tt}`, typos, { bareAm: true })[0]];
  const pf = g('time_from_pm'), pt = g('time_to_pm');
  if (!P.isBlank(pf) && !P.isBlank(pt)) windows.push(P.parseTimes(`${pf} to ${pt}`, typos)[0]);
  return { entries: P.entriesFor(mask, windows) };
}

// Raw geometry is in BNG metres. Convert to WGS84, and refuse anything that already looks like degrees
// (that would mean the fetch regressed to the server's un-shifted outSR=4326).
function mapCoords(c) {
  if (typeof c[0] === 'number') {
    if (Math.abs(c[0]) < 1000) throw new Error(`expected British National Grid metres, got ${JSON.stringify(c)}; fetch.mjs must use outSR=27700`);
    return bngToLonLat(c[0], c[1]);
  }
  return c.map(mapCoords);
}
const toWgs84 = (g) => (g && g.coordinates && g.coordinates.length ? { type: g.type, coordinates: mapCoords(g.coordinates) } : g);

const TRO_KINDS = { permit: 1, shared: 1, paid: 1, limited: 1 };
const gisHours = new Map();   // 'kind|zone' -> Set of ruleset ids seen in the GIS
const meta = { layers: {}, rulesets: 0, crs: 'EPSG:27700 -> WGS84 (Helmert + local shift, see scripts/lib/bng.mjs)' };
for (const [id, cfg] of Object.entries(LAYERS)) {
  const info = JSON.parse(await readFile(raw(`L${id}.info.json`), 'utf8'));
  const gj = JSON.parse(await readFile(raw(`L${id}.geojson`), 'utf8'));
  const feats = [];
  const stats = { count: gj.features.length, kept: 0, emptyGeometry: 0, nullGeometry: 0, unknown: 0, unknownReasons: {} };
  for (const f of gj.features) {
    const p = f.properties;
    const oid = p.OBJECTID;
    const g = getter(p);
    const err = (field, rawv, msg) => errors.push({ layer: +id, objectid: oid, field, raw: rawv, msg });
    const geometry = cleanGeometry(toWgs84(f.geometry), COORD_DP, SIMPLIFY_TOL);
    if (!geometry) { if (!f.geometry || !f.geometry.coordinates?.length) stats.nullGeometry++; else stats.emptyGeometry++; continue; }

    // apply overrides
    let ov = overrides.get(`${id}:${oid}`) || [];
    ov.forEach((o) => usedOverrides.add(`${id}:${oid}`));
    const forced = ov.find((o) => o.field === 'rules');
    const patch = {};
    for (const o of ov) if (o.field !== 'rules') patch[o.field.toLowerCase()] = o.value;
    const gg = (k) => (k.toLowerCase() in patch ? patch[k.toLowerCase()] : g(k));

    let res;
    try {
      if (forced) res = { entries: P.parseSpec(forced.value) };
      else if (cfg.kind === 'dy' || cfg.kind === 'red') res = { entries: P.ALWAYS };
      else if (cfg.kind === 'sy') res = rulesForSingleYellow(gg);
      else res = rulesFromDaysTimes(gg('days'), gg('times'));
    } catch (e) {
      if (e instanceof P.ParseError) { err('days/times', `${gg('days')} | ${gg('times')}`, e.message); continue; }
      throw e;
    }

    const props = { i: oid, k: cfg.kind };
    const zone = P.parseZone(gg('zone')); if (zone) props.z = zone;
    const tariff = P.parseTariff(gg('tariff')); if (tariff) props.t = tariff;
    for (const [src, dst] of [['max_stay', 'ms'], ['no_return', 'nr']]) {
      const d = P.parseDuration(gg(src));
      if (d.v != null) props[dst] = d.v;
      if (d.warn) warnings.push({ layer: +id, objectid: oid, field: src, msg: d.warn });
    }
    const pbp = gg('pay_by_phone_code'); if (!P.isBlank(pbp)) props.p = String(pbp).trim();
    if (res.unknown) { props.r = -1; stats.unknown++; stats.unknownReasons[res.unknown] = (stats.unknownReasons[res.unknown] || 0) + 1; }
    else props.r = intern(res.entries);
    if (NAMED.has(cfg.kind)) { const si = streetOf(geometry); feats0.total++; if (si != null) { props.s = si; feats0.named++; } }
    feats.push({ type: 'Feature', geometry, properties: props });
    stats.kept++;
  }
  if (cfg.kind in TRO_KINDS) for (const f of feats) { const z = f.properties.z, r = f.properties.r; if (z && r >= 0) { const k = `${cfg.kind}|${z}`; (gisHours.get(k) || gisHours.set(k, new Set()).get(k)).add(r); } }
  stats.lastEditDate = info.lastEditDate;
  meta.layers[id] = { key: cfg.key, ...stats };
  await writeFile(new URL(`${cfg.key}.geojson`, out), JSON.stringify({ type: 'FeatureCollection', features: feats }));
  console.log(`${cfg.key.padEnd(8)} ${String(stats.count).padStart(6)} in -> ${String(stats.kept).padStart(6)} kept, ${stats.unknown} unknown, ${stats.nullGeometry} null geom, ${stats.emptyGeometry} collapsed by rounding`);
}

// Cross-check against the legal order (data-src/zones.csv, built by scripts/tro-zones.mjs). Warnings only:
// the TRO can be ahead of the GIS (amendments), so a mismatch is a prompt to look, not a build failure.
const tro = new Map();   // 'kind|zone' -> {keys:Set, complete:boolean}
try {
  for (const line of (await readFile(new URL('data-src/zones.csv', root), 'utf8')).split('\n').slice(1)) {
    if (!line.trim()) continue;
    const [zone, kind, part, spec] = line.split(',');
    const k = `${kind}|${zone}`;
    const t = tro.get(k) || tro.set(k, { keys: new Set(), complete: true, parts: [] }).get(k);
    if (!spec) { t.complete = false; continue; }
    const ents = spec.split(';').map((e) => e.split(':').map(Number));
    t.keys.add(entriesKey(ents)); t.parts.push(part);
  }
} catch { warnings.push({ msg: 'data-src/zones.csv missing; TRO cross-check skipped' }); }
let troChecked = 0, troMismatch = 0;
for (const [k, ids] of gisHours) {
  const t = tro.get(k);
  if (!t || !t.keys.size) continue;
  // each GIS ruleset should equal one TRO part's hours (a TRO part may be a single window; GIS merges them)
  const troAll = entriesKey([...t.keys].flatMap((x) => JSON.parse(x)));
  for (const r of ids) {
    troChecked++;
    const gk = entriesKey(rulesets[r]);
    if (t.keys.has(gk) || gk === troAll) continue;
    if (!t.complete) continue;   // some TRO headings for this zone/kind weren't machine-readable
    troMismatch++;
    warnings.push({ msg: `TRO cross-check: ${k} GIS hours ${JSON.stringify(rulesets[r])} not in the TRO schedule (${[...t.keys].join(' / ')})` });
  }
}
meta.troCheck = { compared: troChecked, mismatches: troMismatch };
console.log(`TRO cross-check: ${troChecked} zone/hours combinations compared, ${troMismatch} differ`);

for (const k of overrides.keys()) if (!usedOverrides.has(k)) warnings.push({ msg: `override ${k} matched no feature` });
meta.rulesets = rulesets.length;
if (roads) {
  // Are our bays where the roads are? A coordinate/datum bug shows up as a large systematic shift.
  const bays = ['paid', 'shared', 'limited'].flatMap((k) => JSON.parse(readFileSync(new URL(`${k}.geojson`, out), 'utf8')).features);
  const a = alignment(roads, samplePoints(bays, 2500));
  meta.alignment = { atZero: +a.zero.toFixed(3), best: +a.best.toFixed(3), shiftE: a.shiftE, shiftN: a.shiftN, shiftMetres: +a.shiftMetres.toFixed(1) };
  console.log(`Alignment vs OSM: ${(a.zero * 100).toFixed(0)}% of bay vertices within 4 m of a named road; best shift ${a.shiftE} m E, ${a.shiftN} m N`);
  const named = feats0.named, total = feats0.total;
  meta.streetCoverage = +(named / total).toFixed(3);
  console.log(`Street names: ${named}/${total} features named, ${streets.length} distinct streets`);
}
// Double yellows are ~3 MB, so ship them as 0.02-degree tiles the client loads for the area in view.
{
  const TILE = 0.02;
  const dy = JSON.parse(readFileSync(new URL('dy.geojson', out), 'utf8'));
  const cells = new Map();
  const first = (c) => (typeof c[0] === 'number' ? c : first(c[0]));
  for (const f of dy.features) {
    const [lon, lat] = first(f.geometry.coordinates);
    const k = `${Math.floor(lon / TILE)}_${Math.floor(lat / TILE)}`;
    (cells.get(k) || cells.set(k, []).get(k)).push(f);
  }
  await mkdir(new URL('dy/', out), { recursive: true });
  for (const [k, fs] of cells) await writeFile(new URL(`dy/${k}.geojson`, out), JSON.stringify({ type: 'FeatureCollection', features: fs }));
  meta.dyTiles = { size: TILE, cells: [...cells.keys()].sort() };
  console.log(`dy: ${dy.features.length} features in ${cells.size} tiles`);
}
await writeFile(new URL('streets.json', out), JSON.stringify(streets));
await writeFile(new URL('rules.json', out), JSON.stringify(rulesets));
await writeFile(new URL('meta.draft.json', out), JSON.stringify(meta));
await writeFile(new URL('report.json', out), JSON.stringify({ errors, warnings }, null, 1));
console.log(`${rulesets.length} distinct rule sets; ${errors.length} errors; ${warnings.length} warnings`);
for (const e of errors.slice(0, 25)) console.error('ERROR', JSON.stringify(e));
if (errors.length) process.exit(1);
