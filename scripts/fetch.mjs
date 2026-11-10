// Pull every configured layer from the council FeatureServer as GeoJSON (WGS84), paged.
import { mkdir, writeFile } from 'node:fs/promises';
import { BASE, UA, PAGE, LAYERS } from './lib/config.mjs';

const OUT = new URL('../.cache/raw/', import.meta.url);
await mkdir(OUT, { recursive: true });

async function getJson(url, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (j.error) throw new Error(`ArcGIS error ${JSON.stringify(j.error)}`);
      return j;
    } catch (e) {
      if (i === tries) throw new Error(`${url}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
}

for (const id of Object.keys(LAYERS)) {
  const q = (extra) => `${BASE}/${id}/query?where=1%3D1&${extra}&f=`;
  const { count } = await getJson(q('returnCountOnly=true') + 'json');
  const info = await getJson(`${BASE}/${id}?f=json`);
  const features = [];
  for (let offset = 0; offset < count; offset += PAGE) {
    const page = await getJson(
      q(`outFields=*&outSR=4326&orderByFields=OBJECTID&resultOffset=${offset}&resultRecordCount=${PAGE}`) + 'geojson');
    features.push(...page.features);
    await new Promise((r) => setTimeout(r, 500)); // be polite
  }
  if (features.length !== count) throw new Error(`layer ${id}: expected ${count} features, got ${features.length}`);
  await writeFile(new URL(`L${id}.geojson`, OUT), JSON.stringify({ type: 'FeatureCollection', features }));
  await writeFile(new URL(`L${id}.info.json`, OUT), JSON.stringify({
    count, name: info.name, lastEditDate: info.editingInfo?.lastEditDate ?? info.editingInfo?.dataLastEditDate ?? null,
    fields: (info.fields || []).map((f) => f.name),
  }));
  console.log(`layer ${id} (${LAYERS[id].key}): ${features.length} features`);
}
