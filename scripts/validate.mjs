// Sanity-check the freshly built data in .cache/out against the last published data, then publish it.
// Fails loudly (exit 1, nothing published) on: parse errors, a layer dropping >10%, an empty layer,
// too many unknown-hours features, or a big jump in dropped geometries.
import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { LAYERS } from './lib/config.mjs';

const publish = process.argv.includes('--publish');
const root = new URL('../', import.meta.url);
const out = (f) => new URL(`.cache/out/${f}`, root);
const site = (f) => new URL(`site/data/${f}`, root);

const problems = [];
const draft = JSON.parse(await readFile(out('meta.draft.json'), 'utf8'));
const report = JSON.parse(await readFile(out('report.json'), 'utf8'));
let prev = null;
try { prev = JSON.parse(await readFile(site('meta.json'), 'utf8')); } catch { /* first run */ }

if (report.errors.length) problems.push(`${report.errors.length} unparseable feature(s); first: ${JSON.stringify(report.errors[0])}`);

for (const [id, cfg] of Object.entries(LAYERS)) {
  const d = draft.layers[id];
  if (!d || d.kept === 0) { problems.push(`layer ${id} (${cfg.key}) is empty`); continue; }
  if (d.unknown > cfg.maxUnknown) problems.push(`layer ${id} (${cfg.key}): ${d.unknown} unknown-hours features > allowed ${cfg.maxUnknown}`);
  const p = prev?.layers?.[id];
  if (p) {
    if (d.count < p.count * 0.9 && p.count - d.count >= 3) problems.push(`layer ${id} (${cfg.key}): count fell ${p.count} -> ${d.count} (>10%)`);
    const lost = d.nullGeometry + d.emptyGeometry, wasLost = p.nullGeometry + p.emptyGeometry;
    if (lost > wasLost + Math.max(5, d.count * 0.02)) problems.push(`layer ${id} (${cfg.key}): dropped geometries jumped ${wasLost} -> ${lost}`);
  }
}

if (problems.length) {
  console.error('VALIDATION FAILED - nothing published:\n - ' + problems.join('\n - '));
  process.exit(1);
}

// geometry sanity: every output coordinate must sit inside Greater Brighton & Hove
for (const l of Object.values(LAYERS)) {
  const g = JSON.parse(await readFile(out(`${l.key}.geojson`), 'utf8'));
  let bad = 0;
  const walk = (c) => (typeof c[0] === 'number' ? (c[0] < -0.35 || c[0] > 0.12 || c[1] < 50.77 || c[1] > 50.93) && bad++ : c.forEach(walk));
  g.features.forEach((f) => walk(f.geometry.coordinates));
  if (bad) problems.push(`layer ${l.key}: ${bad} coordinate(s) outside the Brighton & Hove area`);
}
if (problems.length) { console.error('VALIDATION FAILED - nothing published:\n - ' + problems.join('\n - ')); process.exit(1); }

// content hash of everything the client downloads (so an unchanged council dataset => no commit)
const files = [...Object.values(LAYERS).map((l) => `${l.key}.geojson`), 'rules.json'];
const hash = createHash('sha1');
for (const f of files) hash.update(await readFile(out(f)));
const digest = hash.digest('hex').slice(0, 16);

if (prev?.hash === digest) { console.log('No data change since last publish.'); process.exit(0); }
if (!publish) { console.log('Validation OK (dry run, not publishing).'); process.exit(0); }

await mkdir(new URL('site/data/', root), { recursive: true });
for (const f of files) await copyFile(out(f), site(f));
await writeFile(site('meta.json'), JSON.stringify({ generated: new Date().toISOString(), hash: digest, ...draft }, null, 1));
console.log(`Published ${files.length} files (hash ${digest}).`);
for (const w of report.warnings) console.log('warning:', JSON.stringify(w));
