// Pure status engine: no DOM, no network. All times are Europe/London wall-clock.
// A rule set is an array of entries [dayMask, fromMin, toMin]; Mon = bit 0 ... Sun = bit 6.
// toMin < fromMin means the window starts on a masked day and runs into the next morning.
// A kerb is "restricted" inside any window (paid / permit-only / limited / no waiting) and free outside.

export const TZ = 'Europe/London';
const fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, year: 'numeric', month: 'numeric', day: 'numeric',
  hour: 'numeric', minute: 'numeric', weekday: 'short', hourCycle: 'h23',
});
const DOW = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const DOW_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** London wall-clock parts of an instant. dow: Mon=1..Sun=7, min: minutes since local midnight. */
export function londonParts(date) {
  const p = {};
  for (const x of fmt.formatToParts(date)) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day, min: (+p.hour % 24) * 60 + +p.minute, dow: DOW[p.weekday] };
}

/** Instant for a London wall-clock time. min may be 1440+ (rolls into next day). */
export function londonWallToInstant(y, m, d, min) {
  const want = Date.UTC(y, m - 1, d, 0, min);
  let t = want;
  for (let i = 0; i < 4; i++) {
    const p = londonParts(new Date(t));
    const got = Date.UTC(p.y, p.m - 1, p.d, 0, p.min);
    const diff = want - got;
    if (!diff) break;
    t += diff;
  }
  return new Date(t);
}

/** Calendar day (London) offset days after the given parts. */
function addDays(p, n) {
  const dt = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), dow: ((dt.getUTCDay() + 6) % 7) + 1 };
}

export function isRestricted(entries, p) {
  const bit = 1 << (p.dow - 1);
  const prevBit = 1 << ((p.dow + 5) % 7);
  for (const [mask, from, to] of entries) {
    if (to > from) { if (mask & bit && p.min >= from && p.min < to) return true; }
    else { // overnight
      if (mask & bit && p.min >= from) return true;
      if (mask & prevBit && p.min < to) return true;
    }
  }
  return false;
}

const RESTRICT_STATUS = { paid: 'paid', shared: 'paid', permit: 'permit', limited: 'limited', sy: 'nopark', dy: 'nopark', red: 'nopark' };

/**
 * Evaluate one feature at an instant.
 * feature: {k, r}  (r = rule set index, -1 = unknown)   rulesets: array of entry arrays
 * -> { status: 'free'|'paid'|'permit'|'limited'|'nopark'|'unknown', restricted, next: {at: Date, status} | null }
 */
export function evaluate(feature, rulesets, date) {
  const kind = feature.k;
  if (kind === 'dy' || kind === 'red') return { status: 'nopark', restricted: true, next: null };
  if (feature.r == null || feature.r < 0) return { status: 'unknown', restricted: null, next: null };
  const entries = rulesets[feature.r];
  const restrictedStatus = RESTRICT_STATUS[kind] ?? 'paid';
  const now = londonParts(date);
  const restricted = isRestricted(entries, now);
  const status = restricted ? restrictedStatus : 'free';

  // next change: collect every window boundary over the next 8 London days, take the first that flips the state
  const cands = [];
  for (let n = 0; n <= 8; n++) {
    const day = addDays(now, n);
    const bit = 1 << (day.dow - 1);
    for (const [mask, from, to] of entries) {
      if (!(mask & bit)) continue;
      cands.push(londonWallToInstant(day.y, day.m, day.d, from));
      cands.push(londonWallToInstant(day.y, day.m, day.d, to > from ? to : to + 1440));
    }
  }
  cands.sort((a, b) => a - b);
  let next = null;
  for (const c of cands) {
    if (c <= date) continue;
    const r = isRestricted(entries, londonParts(c));
    if (r !== restricted) { next = { at: c, status: r ? restrictedStatus : 'free' }; break; }
  }
  return { status, restricted, next };
}

// ---------- formatting ----------
export const KIND_LABEL = {
  paid: 'Paid bay', shared: 'Shared permit / paid bay', permit: 'Permit holders only',
  limited: 'Free limited waiting', sy: 'Single yellow line', dy: 'Double yellow line', red: 'Red route',
};

export function fmtTime(date) {
  const p = londonParts(date);
  return `${String(Math.floor(p.min / 60)).padStart(2, '0')}:${String(p.min % 60).padStart(2, '0')}`;
}

/** '' (same day), ' tomorrow' or ' Sat' relative to `now` in London. */
export function dayHint(at, now) {
  const a = londonParts(at), n = londonParts(now);
  const days = Math.round((Date.UTC(a.y, a.m - 1, a.d) - Date.UTC(n.y, n.m - 1, n.d)) / 86400000);
  if (days <= 0) return '';
  if (days === 1) return ' tomorrow';
  return ' ' + DOW_NAMES[a.dow - 1];
}

export function fmtDuration(min) {
  if (min == null) return null;
  if (min < 60) return `${min} min`;
  const h = min / 60;
  return Number.isInteger(h) ? `${h} hr${h === 1 ? '' : 's'}` : `${min} min`;
}

const START_VERB = { paid: 'paid parking starts', shared: 'paid parking starts', permit: 'permit-only starts', limited: 'time limit starts', sy: 'restriction starts' };
const NOW_LABEL = { paid: 'Paid now', permit: 'Permit holders only now', limited: 'Limited waiting now', nopark: 'No parking now' };

/** Short human status line, e.g. "Free now, restriction starts 09:00" / "Permit holders only now, free from 20:00". */
export function describeStatus(kind, ev, now) {
  if (ev.status === 'unknown') return 'Hours unknown. Check the sign.';
  if (kind === 'dy') return 'No parking at any time';
  if (kind === 'red') return 'No stopping (red route), at any time';
  if (ev.status === 'free') {
    if (!ev.next) return 'Free';
    return `Free now, ${START_VERB[kind] || 'restriction starts'} ${fmtTime(ev.next.at)}${dayHint(ev.next.at, now)}`;
  }
  const label = NOW_LABEL[ev.status] || 'Restricted now';
  return ev.next ? `${label}, free from ${fmtTime(ev.next.at)}${dayHint(ev.next.at, now)}` : `${label} at any time`;
}

function maskLabel(mask) {
  if (mask === 127) return 'Mon–Sun';
  const runs = [];
  for (let i = 0; i < 7;) {
    if (!(mask & (1 << i))) { i++; continue; }
    let j = i;
    while (j + 1 < 7 && mask & (1 << (j + 1))) j++;
    runs.push(j - i >= 2 ? `${DOW_NAMES[i]}–${DOW_NAMES[j]}` : j > i ? `${DOW_NAMES[i]}, ${DOW_NAMES[j]}` : DOW_NAMES[i]);
    i = j + 1;
  }
  return runs.join(', ');
}
const hhmm = (m) => `${String(Math.floor((m % 1440) / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** "Mon–Fri, Sun 09:00–20:00; Sat 09:00–16:00" */
export function describeRules(entries) {
  if (!entries) return 'Hours unknown';
  if (entries.length === 1 && entries[0][0] === 127 && entries[0][1] === 0 && entries[0][2] === 1440) return 'At any time';
  const groups = new Map(); // mask -> windows
  for (const [mask, f, t] of entries) {
    if (!groups.has(mask)) groups.set(mask, []);
    groups.get(mask).push(`${hhmm(f)}–${hhmm(t)}`);
  }
  // merge masks that share identical windows
  const byWindows = new Map();
  for (const [mask, w] of groups) { const k = w.join(' & '); byWindows.set(k, (byWindows.get(k) || 0) | mask); }
  return [...byWindows].map(([w, mask]) => `${maskLabel(mask)} ${w}`).join('; ');
}
