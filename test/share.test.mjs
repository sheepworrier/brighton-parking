import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeView, decodeView } from '../site/share.js';

const CATS = ['pay', 'permit', 'sy', 'limited', 'dy', 'red'];
const now = new Date('2026-11-10T14:00:00Z');
const base = { pay: true, permit: false, sy: false, limited: false, dy: false, red: false };

test('default view with nothing searched is an empty hash', () => {
  assert.equal(encodeView({ cats: base }), '');
});

test('round trip: search, time, categories and map view', () => {
  const view = {
    q: 'Unithai', origin: { lat: 50.82735, lon: -0.15208, label: 'Unithai, 10' },
    when: new Date('2026-11-10T19:00:00Z'), cats: { ...base, permit: true, sy: true },
    map: { lat: 50.8273, lon: -0.1521, zoom: 16.5 },
  };
  const hash = encodeView(view);
  assert.equal(hash, 'q=Unithai&ll=50.82735,-0.15208&l=Unithai%2C%2010&t=2026-11-10T19:00Z&c=pay,permit,sy&v=50.8273,-0.1521,16.5');
  const back = decodeView('#' + hash, now, CATS);
  assert.equal(back.q, 'Unithai');
  assert.deepEqual(back.origin, { lat: 50.82735, lon: -0.15208, label: 'Unithai, 10' });
  assert.equal(back.when.toISOString(), '2026-11-10T19:00:00.000Z');
  assert.deepEqual(back.cats, { pay: true, permit: true, sy: true, limited: false, dy: false, red: false });
  assert.deepEqual(back.map, { lat: 50.8273, lon: -0.1521, zoom: 16.5 });
});

test('"Now" is not stored, so a shared link opens at the viewer\'s now', () => {
  assert.ok(!encodeView({ origin: { lat: 50.8, lon: -0.1, label: 'x' }, when: null, cats: base }).includes('t='));
});

test('a past planned time is dropped; a future one kept', () => {
  assert.equal(decodeView('t=2026-11-09T19:00Z', now, CATS).when, undefined);
  assert.ok(decodeView('t=2026-11-10T13:55Z', now, CATS).when);          // within the 10 min grace
  assert.equal(decodeView('t=2027-06-01T19:00Z', now, CATS).when, undefined); // absurdly far ahead
});

test('all categories off is representable', () => {
  const h = encodeView({ cats: { ...base, pay: false } });
  assert.equal(h, 'c=none');
  assert.deepEqual(decodeView(h, now, CATS).cats, Object.fromEntries(CATS.map((c) => [c, false])));
});

test('geolocation label is not leaked as "your location"', () => {
  assert.match(encodeView({ origin: { lat: 50.8, lon: -0.1, label: 'your location' }, cats: base }), /l=a%20location/);
});

test('garbage and hostile input is ignored safely', () => {
  assert.deepEqual(decodeView('', now, CATS), {});
  assert.deepEqual(decodeView('#ll=abc,def&t=nonsense&c=bogus,<script>&v=1,2,99', now, CATS).origin, undefined);
  const d = decodeView('#ll=0,0&v=50.8,-0.1,99&c=bogus,permit&q=%E0%A4%A', now, CATS);
  assert.equal(d.origin, undefined);        // outside the Brighton sanity box
  assert.equal(d.map, undefined);           // zoom out of range
  assert.deepEqual(Object.keys(d.cats).filter((k) => d.cats[k]), ['permit']);
  assert.equal(d.q, undefined);             // malformed percent-encoding skipped
});

test('label and query are length-limited', () => {
  const d = decodeView('q=' + 'a'.repeat(500) + '&ll=50.8,-0.1&l=' + 'b'.repeat(500), now, CATS);
  assert.equal(d.q.length, 100);
  assert.equal(d.origin.label.length, 80);
});
