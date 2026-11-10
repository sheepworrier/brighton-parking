import test from 'node:test';
import assert from 'node:assert/strict';
import { makeProjector, measure, nearby, haversine, metresToLonLat } from '../site/geo.js';

const origin = { lat: 50.8225, lon: -0.1372 };
const proj = makeProjector(origin.lat, origin.lon);
const at = (dx, dy) => metresToLonLat(origin, dx, dy);

test('point-to-line distance', () => {
  const g = { type: 'LineString', coordinates: [at(-50, 100), at(50, 100)] };
  assert.ok(Math.abs(measure(g, proj).d - 100) < 0.5);
});

test('polygon distance uses nearest edge', () => {
  const sq = [at(10, 10), at(20, 10), at(20, 20), at(10, 20), at(10, 10)];
  const d = measure({ type: 'Polygon', coordinates: [sq] }, proj).d;
  assert.ok(Math.abs(d - Math.hypot(10, 10)) < 0.5);
});

test('haversine ~ projector', () => {
  const p = metresToLonLat(origin, 300, 400);
  assert.ok(Math.abs(haversine(origin, { lon: p[0], lat: p[1] }) - 500) < 2);
});

test('nearby filters by radius, clusters same key within link distance, splits by key', () => {
  const bay = (dx, dy, key) => ({ properties: { key }, geometry: { type: 'Polygon', coordinates: [[at(dx, dy), at(dx + 5, dy), at(dx + 5, dy + 2), at(dx, dy + 2), at(dx, dy)]] } });
  const feats = [bay(100, 0, 'A'), bay(110, 0, 'A'), bay(120, 0, 'A'), bay(100, 10, 'B'), bay(300, 0, 'A'), bay(900, 0, 'A')];
  const c = nearby(feats, origin, 600, (f) => f.properties.key);
  const keys = c.map((x) => `${x.key}:${x.items.length}`).sort();
  assert.deepEqual(keys, ['A:3', 'A:1', 'B:1'].sort());
  assert.ok(c[0].d <= c[c.length - 1].d);
});
