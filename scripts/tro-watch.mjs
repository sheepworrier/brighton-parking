// Lists amendment-style documents on the council's TRO index and reports any not in data-src/tro-seen.json.
// Writes tro-report.md and sets the `new_count` step output. Acknowledge by adding names to tro-seen.json
// (run with --accept to do that automatically after you've reviewed them).
import fs from 'node:fs';
import { UA } from './lib/config.mjs';

const INDEX = 'https://tro.tpt.gov.uk/brighton-and-hove/';
const SEEN = new URL('../data-src/tro-seen.json', import.meta.url);
const accept = process.argv.includes('--accept');

/** Pure: pull "Amend / SEA / OUT" document names (without the numeric prefix) out of the index HTML. */
export function extractDocs(html) {
  const out = new Set();
  for (const m of html.matchAll(/href="[^"]*\/([^"\/]+?\.pdf)"/gi)) {
    const name = decodeURIComponent(m[1]);
    if (/amend|sea-|out-|etro|experimental/i.test(name)) out.add(name);
  }
  return [...out].sort();
}

async function main() {
  const res = await fetch(INDEX, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`TRO index HTTP ${res.status}`);
  const docs = extractDocs(await res.text());
  if (!docs.length) throw new Error('TRO index parsed to zero documents; the page layout probably changed');
  const seen = new Set(fs.existsSync(SEEN) ? JSON.parse(fs.readFileSync(SEEN, 'utf8')) : []);
  const fresh = docs.filter((d) => !seen.has(d));
  if (accept) { fs.writeFileSync(SEEN, JSON.stringify(docs, null, 1) + '\n'); console.log(`accepted ${docs.length} documents`); return; }
  const report = fresh.length
    ? `The TRO index (${INDEX}) lists ${fresh.length} document(s) we haven't reviewed:\n\n${fresh.map((d) => `- ${d}`).join('\n')}\n\nCheck whether the council GIS has caught up (permit/paid changes especially), add rows to \`data-src/overrides.csv\` if needed, then run \`node scripts/tro-watch.mjs --accept\` and commit \`data-src/tro-seen.json\`.\n`
    : 'No new documents.\n';
  fs.writeFileSync('tro-report.md', report);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `new_count=${fresh.length}\n`);
  console.log(report);
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
