// Raw council GeoJSON -> compact, normalised site data in .cache/out (validate.mjs publishes it).
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { LAYERS, COORD_DP, SIMPLIFY_TOL } from './lib/config.mjs';
import * as P from './lib/parse.mjs';
import { cleanGeometry } from './lib/geom.mjs';
import { bngToLonLat } from './lib/bng.mjs';

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
    feats.push({ type: 'Feature', geometry, properties: props });
    stats.kept++;
  }
  stats.lastEditDate = info.lastEditDate;
  meta.layers[id] = { key: cfg.key, ...stats };
  await writeFile(new URL(`${cfg.key}.geojson`, out), JSON.stringify({ type: 'FeatureCollection', features: feats }));
  console.log(`${cfg.key.padEnd(8)} ${String(stats.count).padStart(6)} in -> ${String(stats.kept).padStart(6)} kept, ${stats.unknown} unknown, ${stats.nullGeometry} null geom, ${stats.emptyGeometry} collapsed by rounding`);
}

for (const k of overrides.keys()) if (!usedOverrides.has(k)) warnings.push({ msg: `override ${k} matched no feature` });
meta.rulesets = rulesets.length;
await writeFile(new URL('rules.json', out), JSON.stringify(rulesets));
await writeFile(new URL('meta.draft.json', out), JSON.stringify(meta));
await writeFile(new URL('report.json', out), JSON.stringify({ errors, warnings }, null, 1));
console.log(`${rulesets.length} distinct rule sets; ${errors.length} errors; ${warnings.length} warnings`);
for (const e of errors.slice(0, 25)) console.error('ERROR', JSON.stringify(e));
if (errors.length) process.exit(1);
