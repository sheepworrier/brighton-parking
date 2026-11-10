import test from 'node:test';
import assert from 'node:assert/strict';
import { londonParts, londonWallToInstant, isRestricted, evaluate, describeStatus, describeRules, fmtTime } from '../site/engine.js';

const h = (x, m = 0) => x * 60 + m;
const ALL = 127, MONFRI = 31;
// rule sets used below
const RS = [
  [[ALL, h(9), h(20)]],                                  // 0: permit Mon-Sun 9-20
  [[MONFRI, h(9), h(10)], [MONFRI, h(13), h(14)]],       // 1: zone P  Mon-Fri 9-10 & 1-2
  [[ALL, h(11), h(12)], [ALL, h(18), h(19)]],            // 2: zone L  11-12 & 18-19
  [[0b1011111, h(9), h(20)], [32, h(9), h(16)]],         // 3: zone Y Part 4.3 (Sat 9-16)
  [[ALL, 0, 1440]],                                      // 4: always
  [[ALL, h(20), h(8)]],                                  // 5: overnight 20:00-08:00
];
const D = (iso) => new Date(iso);
const ev = (k, r, iso) => evaluate({ k, r }, RS, D(iso));

test('londonParts: BST vs GMT', () => {
  assert.deepEqual(londonParts(D('2026-07-01T19:30:00Z')), { y: 2026, m: 7, d: 1, min: h(20, 30), dow: 3 });
  assert.deepEqual(londonParts(D('2026-01-15T19:30:00Z')), { y: 2026, m: 1, d: 15, min: h(19, 30), dow: 4 });
});

test('londonWallToInstant round-trips, BST and GMT', () => {
  assert.equal(londonWallToInstant(2026, 7, 1, h(9)).toISOString(), '2026-07-01T08:00:00.000Z');
  assert.equal(londonWallToInstant(2026, 1, 15, h(9)).toISOString(), '2026-01-15T09:00:00.000Z');
  assert.equal(londonWallToInstant(2026, 11, 10, 1440).toISOString(), '2026-11-11T00:00:00.000Z');
});

test('Zone Y permit bay 09-20 (GMT, Tue 10 Nov 2026)', () => {
  let e = ev('permit', 0, '2026-11-10T12:00:00Z');
  assert.equal(e.status, 'permit');
  assert.equal(e.next.at.toISOString(), '2026-11-10T20:00:00.000Z');
  assert.equal(e.next.status, 'free');
  assert.equal(describeStatus('permit', e, D('2026-11-10T12:00:00Z')), 'Permit holders only now, free from 20:00');
  e = ev('permit', 0, '2026-11-10T07:00:00Z');
  assert.equal(e.status, 'free');
  assert.equal(e.next.at.toISOString(), '2026-11-10T09:00:00.000Z');
  assert.equal(describeStatus('permit', e, D('2026-11-10T07:00:00Z')), 'Free now, permit-only starts 09:00');
});

test('boundaries: restricted AT start, free AT end', () => {
  assert.equal(ev('permit', 0, '2026-11-10T09:00:00Z').status, 'permit');
  assert.equal(ev('permit', 0, '2026-11-10T08:59:00Z').status, 'free');
  assert.equal(ev('permit', 0, '2026-11-10T20:00:00Z').status, 'free');
  assert.equal(ev('permit', 0, '2026-11-10T19:59:00Z').status, 'permit');
});

test('BST: 19:30Z in July is 20:30 London so free; in January it is 19:30 so restricted', () => {
  assert.equal(ev('permit', 0, '2026-07-01T19:30:00Z').status, 'free');
  assert.equal(ev('permit', 0, '2026-01-15T19:30:00Z').status, 'permit');
});

test('Mon-Fri rule on a Saturday: next change is Monday', () => {
  const now = '2026-11-14T10:00:00Z'; // Saturday
  const e = ev('permit', 1, now);
  assert.equal(e.status, 'free');
  assert.equal(e.next.at.toISOString(), '2026-11-16T09:00:00.000Z');
  assert.equal(describeStatus('permit', e, D(now)), 'Free now, permit-only starts 09:00 Mon');
});

test('split windows (zone L)', () => {
  let e = ev('permit', 2, '2026-11-10T11:30:00Z');
  assert.equal(e.status, 'permit');
  assert.equal(e.next.at.toISOString(), '2026-11-10T12:00:00.000Z');
  e = ev('permit', 2, '2026-11-10T12:30:00Z');
  assert.equal(e.status, 'free');
  assert.equal(e.next.at.toISOString(), '2026-11-10T18:00:00.000Z');
  e = ev('permit', 2, '2026-11-10T19:30:00Z');
  assert.equal(e.next.at.toISOString(), '2026-11-11T11:00:00.000Z');
  assert.match(describeStatus('permit', e, D('2026-11-10T19:30:00Z')), /tomorrow$/);
});

test('exception rule: Saturday ends at 16:00 (zone Y Part 4.3)', () => {
  const e = ev('permit', 3, '2026-11-14T12:00:00Z'); // Saturday noon
  assert.equal(e.status, 'permit');
  assert.equal(e.next.at.toISOString(), '2026-11-14T16:00:00.000Z');
  assert.equal(ev('permit', 3, '2026-11-14T17:00:00Z').status, 'free');
  assert.equal(ev('permit', 3, '2026-11-15T17:00:00Z').status, 'permit'); // Sunday 17:00
});

test('always / double yellow / red route never change', () => {
  for (const k of ['dy', 'red']) {
    const e = evaluate({ k }, RS, D('2026-11-10T12:00:00Z'));
    assert.equal(e.status, 'nopark'); assert.equal(e.next, null);
  }
  const e = ev('sy', 4, '2026-11-10T12:00:00Z');
  assert.equal(e.status, 'nopark'); assert.equal(e.next, null);
});

test('unknown hours never claim free', () => {
  const e = evaluate({ k: 'sy', r: -1 }, RS, D('2026-11-10T12:00:00Z'));
  assert.equal(e.status, 'unknown');
  assert.match(describeStatus('sy', e, new Date()), /Check the sign/);
});

test('overnight window 20:00-08:00', () => {
  assert.equal(ev('sy', 5, '2026-11-10T22:00:00Z').status, 'nopark');
  assert.equal(ev('sy', 5, '2026-11-11T07:00:00Z').status, 'nopark');
  assert.equal(ev('sy', 5, '2026-11-11T12:00:00Z').status, 'free');
  const e = ev('sy', 5, '2026-11-10T22:00:00Z');
  assert.equal(e.next.at.toISOString(), '2026-11-11T08:00:00.000Z');
});

test('paid / shared kinds map to paid; limited to limited', () => {
  assert.equal(ev('shared', 0, '2026-11-10T12:00:00Z').status, 'paid');
  assert.equal(ev('paid', 0, '2026-11-10T12:00:00Z').status, 'paid');
  assert.equal(ev('limited', 0, '2026-11-10T12:00:00Z').status, 'limited');
});

test('clock change: autumn back (Sun 25 Oct 2026). Sat 21:00 London -> next change Sun 09:00 GMT', () => {
  const now = '2026-10-24T20:00:00Z'; // Sat 21:00 BST
  const e = ev('permit', 0, now);
  assert.equal(e.status, 'free');
  assert.equal(e.next.at.toISOString(), '2026-10-25T09:00:00.000Z');
});

test('clock change: spring forward (Sun 29 Mar 2026). Sat 21:00 GMT -> next change Sun 09:00 BST = 08:00Z', () => {
  const e = ev('permit', 0, '2026-03-28T21:00:00Z');
  assert.equal(e.status, 'free');
  assert.equal(e.next.at.toISOString(), '2026-03-29T08:00:00.000Z');
});

test('describeRules', () => {
  assert.equal(describeRules(RS[0]), 'Mon–Sun 09:00–20:00');
  assert.equal(describeRules(RS[1]), 'Mon–Fri 09:00–10:00 & 13:00–14:00');
  assert.equal(describeRules(RS[3]), 'Mon–Fri, Sun 09:00–20:00; Sat 09:00–16:00');
  assert.equal(describeRules(RS[4]), 'At any time');
});

test('fmtTime is London time', () => {
  assert.equal(fmtTime(D('2026-07-01T08:00:00Z')), '09:00');
});

test('isRestricted exported for UI use', () => {
  assert.equal(isRestricted(RS[0], { dow: 2, min: h(10) }), true);
});
