import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as P from '../scripts/lib/parse.mjs';

const typos = JSON.parse(readFileSync(new URL('../data-src/typos.json', import.meta.url), 'utf8'));
const h = (x) => x * 60;

test('days', () => {
  assert.equal(P.parseDays('Mon to Sun'), 127);
  assert.equal(P.parseDays('Mon to Sat '), 63);
  assert.equal(P.parseDays('Mon  to Fri'), 31);
  assert.equal(P.parseDays('Mon to Thurs'), 15);
  assert.equal(P.parseDays('Mon toi Sun', typos), 127);
  assert.equal(P.parseDays('SAT'), 32);
  assert.throws(() => P.parseDays('Sun to Fri & Sat'), P.ParseError);
});

test('times: simple, spacing, case', () => {
  assert.deepEqual(P.parseTimes('9 am to 8 pm'), [[h(9), h(20)]]);
  assert.deepEqual(P.parseTimes(' 9am to 8pm '), [[h(9), h(20)]]);
  assert.deepEqual(P.parseTimes('9 am to 6 Pm'), [[h(9), h(18)]]);
  assert.deepEqual(P.parseTimes('4:30 PM to 5 pm'), [[h(16) + 30, h(17)]]);
});

test('times: split windows and noon', () => {
  assert.deepEqual(P.parseTimes('11 am to Noon & 6 pm to 7 pm'), [[h(11), h(12)], [h(18), h(19)]]);
  assert.deepEqual(P.parseTimes('10 am to 11 am & 7 pm to 8 pm'), [[h(10), h(11)], [h(19), h(20)]]);
  assert.deepEqual(P.parseTimes('12 pm to 2 pm'), [[h(12), h(14)]]);
  assert.deepEqual(P.parseTimes('12 am to 6 am'), [[0, h(6)]]);
});

test('times: at any time', () => {
  assert.equal(P.parseTimes('At Any Time'), 'always');
  assert.equal(P.parseTimes('At Any time'), 'always');
});

test('times: overnight allowed, zero-length rejected, junk rejected', () => {
  assert.deepEqual(P.parseTimes('8 pm to 8 am'), [[h(20), h(8)]]);
  assert.throws(() => P.parseTimes('9 am to 9 am'), P.ParseError);
  assert.throws(() => P.parseTimes('9 to 6'), P.ParseError);
  assert.throws(() => P.parseTimes('Jrjrjrj'), P.ParseError);
});

test('times: every real-world typo in typos.json resolves', () => {
  for (const bad of Object.keys(typos.times)) assert.ok(Array.isArray(P.parseTimes(bad, typos)), bad);
  for (const bad of Object.keys(typos.days)) assert.ok(Number.isInteger(P.parseDays(bad, typos)), bad);
});

test('bare-am option (single yellow TIME_FROM like "8.30")', () => {
  assert.deepEqual(P.parseTimes('8.30 to 9.30', {}, { bareAm: true }), [[h(8) + 30, h(9) + 30]]);
  assert.throws(() => P.parseTimes('8.30 to 9.30'), P.ParseError);
});

test('duration', () => {
  assert.deepEqual(P.parseDuration('2hr'), { v: 120 });
  assert.deepEqual(P.parseDuration('4 hrs '), { v: 240 });
  assert.deepEqual(P.parseDuration('30mins'), { v: 30 });
  assert.deepEqual(P.parseDuration('11'), { v: 660 });
  assert.deepEqual(P.parseDuration('24hrs'), { v: 1440 });
  assert.deepEqual(P.parseDuration('1 h'), { v: 60 });
  assert.deepEqual(P.parseDuration('NA'), { v: null });
  assert.equal(P.parseDuration('⁶').v, null);
  assert.ok(P.parseDuration('⁶').warn);
});

test('tariff and zone', () => {
  assert.equal(P.parseTariff('Low'), 'L');
  assert.equal(P.parseTariff('High-Summer & Low-Winter'), 'HS');
  assert.equal(P.parseTariff('None'), null);
  assert.equal(P.parseZone(' y '), 'Y');
  assert.equal(P.parseZone('NA'), null);
  assert.equal(P.parseZone('N&R'), 'N&R');
});

test('override spec', () => {
  assert.deepEqual(P.parseSpec('1-5+7@09:00-20:00;6@09:00-16:00'),
    [[0b1011111, h(9), h(20)], [32, h(9), h(16)]]);
  assert.deepEqual(P.parseSpec('always'), P.ALWAYS);
});
