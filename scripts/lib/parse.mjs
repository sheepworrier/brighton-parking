// Parsers for the council's free-text Days / Times / stay fields.
// Rule entry format: [dayMask, fromMin, toMin]  (Mon=bit0 ... Sun=bit6; minutes since local midnight).
// toMin < fromMin means the window starts on a masked day and ends the next morning.
export class ParseError extends Error {}

export const DAY_IDX = { mon: 0, tue: 1, tues: 1, wed: 2, thu: 3, thur: 3, thurs: 3, fri: 4, sat: 5, sun: 6 };
export const ALL_DAYS = 127;

export const clean = (s) => String(s).replace(/ /g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

export function isBlank(s) {
  if (s == null) return true;
  const c = clean(s);
  return c === '' || c === 'none' || c === 'na' || c === 'n/a' || c === '<null>' || c === 'null';
}

const fix = (c, map) => (map && Object.prototype.hasOwnProperty.call(map, c) ? map[c] : c);

function dayBits(from, to) {
  let m = 0;
  for (let d = from; ; d = (d + 1) % 7) {
    m |= 1 << d;
    if (d === to) break;
  }
  return m;
}

/** "Mon to Sun" -> 127, "Mon to Sat" -> 63, "Sat" -> 32 */
export function parseDays(raw, typos = {}) {
  const c = fix(clean(raw), typos.days);
  let m = c.match(/^([a-z]+) to ([a-z]+)$/);
  if (m && m[1] in DAY_IDX && m[2] in DAY_IDX) return dayBits(DAY_IDX[m[1]], DAY_IDX[m[2]]);
  m = c.match(/^([a-z]+)$/);
  if (m && m[1] in DAY_IDX) return 1 << DAY_IDX[m[1]];
  throw new ParseError(`unparseable days: ${JSON.stringify(raw)}`);
}

function parseTimeToken(tok, bareAm) {
  if (tok === 'noon') return 720;
  const m = tok.match(/^(\d{1,2})(?:[.:](\d{2}))?\s*(am|pm)?$/);
  if (!m) throw new ParseError(`bad time token ${JSON.stringify(tok)}`);
  let h = +m[1];
  const min = m[2] ? +m[2] : 0;
  let mer = m[3];
  if (!mer && bareAm) mer = 'am';
  if (!mer) throw new ParseError(`time without am/pm: ${JSON.stringify(tok)}`);
  if (h < 1 || h > 12 || min > 59) throw new ParseError(`time out of range ${JSON.stringify(tok)}`);
  h = (h % 12) + (mer === 'pm' ? 12 : 0);
  return h * 60 + min;
}

/** "9 am to 8 pm" -> [[540,1200]];  "11 am to Noon & 6 pm to 7 pm" -> two windows;  "At Any Time" -> 'always' */
export function parseTimes(raw, typos = {}, { bareAm = false } = {}) {
  const c = fix(clean(raw), typos.times);
  if (/^at any ?time$/.test(c)) return 'always';
  const out = [];
  for (const seg of c.split('&')) {
    const m = seg.trim().match(/^(.+?)\s+to\s+(.+)$/);
    if (!m) throw new ParseError(`unparseable times: ${JSON.stringify(raw)}`);
    const f = parseTimeToken(m[1].trim(), bareAm);
    const t = parseTimeToken(m[2].trim(), bareAm);
    if (t === f) throw new ParseError(`zero-length window: ${JSON.stringify(raw)}`);
    // t < f means the window crosses midnight (e.g. 8 pm to 8 am); the engine handles it
    out.push([f, t]);
  }
  if (!out.length) throw new ParseError(`no windows: ${JSON.stringify(raw)}`);
  return out;
}

/** "2hrs" -> 120, "30mins" -> 30, "11" -> 660 (bare number = hours), "24hrs" -> 1440. Returns {v, warn}. */
export function parseDuration(raw) {
  if (isBlank(raw)) return { v: null };
  const c = clean(raw);
  let m = c.match(/^(\d+)\s*(?:hrs?|hours?|h)$/);
  if (m) return { v: +m[1] * 60 };
  m = c.match(/^(\d+)\s*(?:mins?|minutes?)$/);
  if (m) return { v: +m[1] };
  m = c.match(/^(\d+)$/);
  if (m) return { v: +m[1] * 60 };
  return { v: null, warn: `unrecognised duration ${JSON.stringify(raw)}` };
}

export function entriesFor(mask, windows) {
  return windows.map(([f, t]) => [mask, f, t]);
}
export const ALWAYS = [[ALL_DAYS, 0, 1440]];

/** Override DSL: "1-5+7@09:00-20:00;6@09:00-16:00" (Mon=1..Sun=7) or "always". */
export function parseSpec(spec) {
  if (clean(spec) === 'always') return ALWAYS;
  const out = [];
  for (const part of String(spec).split(';')) {
    const m = part.trim().match(/^([\d+\-]+)@(.+)$/);
    if (!m) throw new ParseError(`bad rules spec ${JSON.stringify(spec)}`);
    let mask = 0;
    for (const d of m[1].split('+')) {
      const r = d.match(/^(\d)(?:-(\d))?$/);
      if (!r) throw new ParseError(`bad day spec ${JSON.stringify(d)}`);
      const a = +r[1] - 1, b = r[2] ? +r[2] - 1 : a;
      mask |= dayBits(a, b);
    }
    for (const w of m[2].split('&')) {
      const t = w.trim().match(/^(\d\d):(\d\d)-(\d\d):(\d\d)$/);
      if (!t) throw new ParseError(`bad window ${JSON.stringify(w)}`);
      out.push([mask, +t[1] * 60 + +t[2], +t[3] * 60 + +t[4]]);
    }
  }
  return out;
}

export const TARIFF = { low: 'L', medium: 'M', high: 'H', 'high-summer & low-winter': 'HS' };
export function parseTariff(raw) {
  if (isBlank(raw)) return null;
  return TARIFF[clean(raw)] ?? null;
}

export function parseZone(raw) {
  if (isBlank(raw)) return null;
  return String(raw).trim().toUpperCase();
}
