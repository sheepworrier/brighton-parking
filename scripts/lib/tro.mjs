// Turn a TRO schedule "Part" heading into a restriction spec we can compare with the council GIS.
// e.g. "Part 4.8 Permit Parking Places Monday to Friday – 9am to 10am and 1pm to 2pm"
//   -> { part: '4.8', layer: 'permit', entries: [[31, 540, 600], [31, 780, 840]] }
// Headings we can't read confidently return entries: null (skipped by the cross-check, never guessed).
const DAYS = { monday: 0, tuesday: 1, wednesday: 2, thursday: 3, friday: 4, saturday: 5, sunday: 6 };
const KINDS = [
  [/^permit (parking places|holders only)/i, 'permit'],
  [/^shared permit or paid/i, 'shared'],
  [/^exclusive paid/i, 'paid'],
  [/^limited waiting/i, 'limited'],
];
const bits = (a, b) => { let m = 0; for (let i = a; i <= b; i++) m |= 1 << i; return m; };

function clock(h, mm, ap) {
  h = +h; mm = +(mm || 0);
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return h * 60 + mm;
}

export function parseHeading(line) {
  const m = line.replace(/\s+/g, ' ').trim().match(/^Part (\d+\.\d+)\s*-?\s*(.*)$/i);
  if (!m) return null;
  const part = m[1];
  const rest = m[2].replace(/[–—]/g, '-');
  const kind = KINDS.find(([re]) => re.test(rest))?.[1];
  if (!kind) return null;
  const res = { part, layer: kind, raw: line.replace(/\s+/g, ' ').trim(), entries: null };
  if (/except|saturday.*and|and.*saturday/i.test(rest) && !/^.*Monday to Sunday/i.test(rest)) { /* fall through to strict parse */ }
  if (/except/i.test(rest)) return res;
  const d = rest.match(/(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday) to (Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/i);
  if (!d) return res;
  const mask = bits(DAYS[d[1].toLowerCase()], DAYS[d[2].toLowerCase()]);
  // hours: after the days, "9am to 8pm", "9am to 10am and 1pm to 2pm", "11 am - Noon & 6 - 7 pm"; drop tariff / stay text
  const after = rest.slice(rest.toLowerCase().indexOf(d[0].toLowerCase()) + d[0].length).replace(/^[\s-]+/, '');
  const hoursPart = after.split(/\s-\s*(?=Low|Medium|High)|\s*-?\s*\d+\s*hours?|\(/i)[0];
  const WIN = /(\d{1,2})(?::(\d\d))?\s*(am|pm)?\s*(?:to|-)\s*(?:(noon)|(\d{1,2})(?::(\d\d))?\s*(am|pm))/gi;
  const windows = [...hoursPart.matchAll(WIN)];
  if (!windows.length) return res;
  const leftover = hoursPart.replace(WIN, '').replace(/\b(and|&)\b|[-\s,&]/gi, '');
  if (leftover) return res;
  res.entries = windows.map((w) => {
    const endAp = w[4] ? 'pm' : w[7].toLowerCase();
    return [mask, clock(w[1], w[2], (w[3] || endAp).toLowerCase()), w[4] ? 720 : clock(w[5], w[6], endAp)];
  });
  return res;
}

export const entriesKey = (entries) => JSON.stringify([...entries].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]));
