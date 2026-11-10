// One-off / occasional: read each zone's TRO Schedule 1 PDF and write data-src/zones.csv, the legal
// hours per zone and bay type. normalise.mjs cross-checks the council GIS against it (warnings only).
// Needs `pdftotext` (brew install poppler). Run: node scripts/tro-zones.mjs
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { UA } from './lib/config.mjs';
import { parseHeading } from './lib/tro.mjs';

const INDEX = 'https://tro.tpt.gov.uk/brighton-and-hove/';
const HOST = 'https://tro.tpt.gov.uk';
const html = await (await fetch(INDEX, { headers: { 'user-agent': UA } })).text();
const files = new Map();
for (const m of html.matchAll(/href="([^"]*Schedule-1-Zone-([A-Z0-9]+)-[^"]*\.pdf)"/gi)) files.set(m[2].toUpperCase(), m[1]);
if (files.size < 25) throw new Error(`expected ~29 zone schedules, found ${files.size}`);

const dir = new URL('../.cache/tro/', import.meta.url);
await mkdir(dir, { recursive: true });
const rows = [['zone', 'layer', 'part', 'spec', 'raw']];
for (const [zone, href] of [...files].sort()) {
  const res = await fetch(new URL(href.replace(/ /g, '%20'), HOST), { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`${zone}: HTTP ${res.status}`);
  const pdf = new URL(`${zone}.pdf`, dir);
  await writeFile(pdf, Buffer.from(await res.arrayBuffer()));
  const text = execFileSync('pdftotext', ['-layout', pdf.pathname, '-'], { maxBuffer: 1 << 28 }).toString();
  const seen = new Set();
  for (const line of text.split('\n')) {
    const h = parseHeading(line.trim());
    if (!h || seen.has(h.part)) continue;
    seen.add(h.part);
    const spec = h.entries ? h.entries.map((e) => e.join(':')).join(';') : '';
    rows.push([zone, h.layer, h.part, spec, JSON.stringify(h.raw).replace(/^"|"$/g, '').replace(/,/g, ' ')]);
  }
  await new Promise((r) => setTimeout(r, 400));
}
await writeFile(new URL('../data-src/zones.csv', import.meta.url), rows.map((r) => r.join(',')).join('\n') + '\n');
console.log(`wrote ${rows.length - 1} rows for ${files.size} zones`);
