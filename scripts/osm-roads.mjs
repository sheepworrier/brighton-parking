// Fetch named OpenStreetMap roads for Brighton & Hove from Overpass into .cache/osm-roads.json.
// Used by normalise (street names) and by the alignment check (catches coordinate/datum errors).
// Run occasionally by hand (`node scripts/osm-roads.mjs`); the result is committed as data-src/osm-roads.json.gz,
// because Overpass is too slow/flaky to depend on inside the weekly Action (it timed out at 20 min).
// The area is fetched as small tiles (Overpass rejects big queries), each tried against several mirrors.
import { writeFile, mkdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { UA } from './lib/config.mjs';

const MIRRORS = ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const ORDER = [0, 0, 1, 0, 1, 2, 0, 1];   // the main instance is the most reliable; fall back to mirrors
const [S, W, N, E] = [50.78, -0.30, 50.92, 0.05];
const NX = 8, NY = 4;
const HW = 'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|pedestrian|road|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link';

async function tile(s, w, n, e) {
  const q = `[out:json][timeout:60];way["highway"~"^(${HW})$"]["name"](${s},${w},${n},${e});out geom tags;`;
  let lastErr;
  for (let attempt = 0; attempt < ORDER.length; attempt++) {
    const url = MIRRORS[ORDER[attempt]];
    try {
      const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(80000), headers: { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(q) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      return { ways: j.elements.filter((x) => x.type === 'way' && x.geometry?.length > 1), ts: j.osm3s?.timestamp_osm_base };
    } catch (err) {
      lastErr = new Error(`${url}: ${err.message}`);
      console.error(`tile ${[s, w].map((v) => v.toFixed(3))} attempt ${attempt + 1}: ${lastErr.message}`);
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

const byId = new Map();
let ts = null;
for (let i = 0; i < NX; i++) for (let j = 0; j < NY; j++) {
  const w = W + ((E - W) / NX) * i, e = W + ((E - W) / NX) * (i + 1);
  const s = S + ((N - S) / NY) * j, n = S + ((N - S) / NY) * (j + 1);
  const t = await tile(s, w, n, e);
  ts = t.ts || ts;
  for (const x of t.ways) byId.set(x.id, { n: x.tags.name, g: x.geometry.map((p) => [+p.lon.toFixed(6), +p.lat.toFixed(6)]) });
}
const ways = [...byId.values()];
if (ways.length < 2000) { console.error(`only ${ways.length} ways; expected thousands`); process.exit(1); }
await mkdir(new URL('../.cache/', import.meta.url), { recursive: true });
const body = JSON.stringify({ fetched: new Date().toISOString(), baseTimestamp: ts, ways });
await writeFile(new URL('../.cache/osm-roads.json', import.meta.url), body);
await writeFile(new URL('../data-src/osm-roads.json.gz', import.meta.url), gzipSync(body, { level: 9 }));
console.log(`OSM: ${ways.length} named road ways`);
