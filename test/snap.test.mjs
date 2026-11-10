import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, toXY, alignment, samplePoints } from '../scripts/lib/snap.mjs';

// a straight east-west road and a north-south road
const ways = [
  { n: 'Test Road', g: [[-0.150, 50.830], [-0.140, 50.830]] },
  { n: 'Cross Street', g: [[-0.145, 50.825], [-0.145, 50.835]] },
];
const idx = buildIndex(ways);

test('nearest names the closest road within range', () => {
  const [x, y] = toXY(-0.1475, 50.83003);
  assert.equal(idx.nearest(x, y, 25).name, 'Test Road');
  const [x2, y2] = toXY(-0.14497, 50.8332);
  assert.equal(idx.nearest(x2, y2, 25).name, 'Cross Street');
});
test('nothing beyond max distance', () => {
  const [x, y] = toXY(-0.1475, 50.8310);   // ~110 m north
  assert.equal(idx.nearest(x, y, 25), null);
});
test('alignment detects a deliberate 100 m-ish offset in a long road', () => {
  // points along Test Road, then moved 9 m north
  const pts = [];
  for (let lon = -0.1495; lon < -0.1405; lon += 0.0002) pts.push(toXY(lon, 50.830));
  const aligned = alignment(idx, pts);
  assert.ok(aligned.shiftMetres <= 1.5, JSON.stringify(aligned));
  const moved = pts.map(([x, y]) => [x, y + 9]);
  const r = alignment(idx, moved);
  assert.ok(r.shiftMetres >= 4 && r.shiftMetres <= 11, JSON.stringify(r));
  assert.ok(r.zero < 0.2);
});
test('samplePoints caps the count', () => {
  const f = [{ geometry: { type: 'LineString', coordinates: Array.from({ length: 100 }, (_, i) => [-0.1 + i * 1e-4, 50.8]) } }];
  assert.equal(samplePoints(f, 10).length, 10);
});
