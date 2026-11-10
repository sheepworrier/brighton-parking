import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHeading, entriesKey } from '../scripts/lib/tro.mjs';

test('plain Mon-Sun heading', () => {
  const h = parseHeading('Part 4.1 - Permit Parking Places Monday to Sunday - 9am to 8pm');
  assert.equal(h.layer, 'permit');
  assert.deepEqual(h.entries, [[127, 540, 1200]]);
});
test('split windows, Mon-Fri', () => {
  const h = parseHeading('Part 4.8 Permit Parking Places Monday to Friday – 9am to 10am and 1pm to 2pm');
  assert.deepEqual(h.entries, [[31, 540, 600], [31, 780, 840]]);
});
test('sloppy "11 am - Noon & 6 - 7 pm" heading', () => {
  const h = parseHeading('Part 4.7 Permit Holders Only, Monday to Sunday, 11 am - Noon & 6 - 7 pm');
  assert.deepEqual(h.entries, [[127, 660, 720], [127, 1080, 1140]]);
});
test('tariff and stay text are ignored, kind is detected', () => {
  const h = parseHeading('Part 5.9 - Shared Permit or Paid Parking Places Monday to Sunday 9am to 8pm - Medium Tariff Short Term - 2');
  assert.equal(h.layer, 'shared');
  assert.deepEqual(h.entries, [[127, 540, 1200]]);
  assert.deepEqual(parseHeading('Part 10.1 - Limited Waiting Parking Places Monday to Sunday - 9am to 8pm- 2 hours (No return within 1').entries, [[127, 540, 1200]]);
});
test('exceptions are not guessed', () => {
  assert.equal(parseHeading('Part 4.3 - Permit Parking Places Monday to Sunday - 9am to 8pm except 9am to 4pm on any Saturday').entries, null);
});
test('other bay types and non-headings are ignored', () => {
  assert.equal(parseHeading('Part 9.1 - Disabled Badge Holder\'s Parking Places At Any Time'), null);
  assert.equal(parseHeading('Some random line'), null);
});
test('entriesKey ignores order', () => {
  assert.equal(entriesKey([[127, 600, 700], [127, 100, 200]]), entriesKey([[127, 100, 200], [127, 600, 700]]));
});
