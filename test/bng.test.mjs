import test from 'node:test';
import assert from 'node:assert/strict';
import { bngToOsgb36, bngToLonLat } from '../scripts/lib/bng.mjs';

const deg = (r) => (r * 180) / Math.PI;
const metres = (lon1, lat1, lon2, lat2) => Math.hypot((lon2 - lon1) * 111320 * Math.cos((lat1 * Math.PI) / 180), (lat2 - lat1) * 110540);
const dms = (d, m, s) => d + m / 60 + s / 3600;

test('BNG -> OSGB36 matches the OS guide worked example (TG 51409 13177) to < 1 cm', () => {
  const [lat, lon] = bngToOsgb36(651409.903, 313177.27);
  assert.ok(Math.abs(deg(lat) - dms(52, 39, 27.2531)) < 1e-7);
  assert.ok(Math.abs(deg(lon) - dms(1, 43, 4.5177)) < 1e-7);
});

test('BNG -> WGS84 is close to the OS ETRS89 value for the same point (Helmert tolerance 8 m)', () => {
  const [lon, lat] = bngToLonLat(651409.903, 313177.27, { east: 0, north: 0 });
  assert.ok(metres(lon, lat, dms(1, 42, 57.8663), dms(52, 39, 28.8282)) < 8);
});

test('the datum shift is applied in the right direction: Brighton moves ~110 m WEST and ~65 m NORTH of the raw OSGB36 position', () => {
  // first vertex of council layer 53 / OBJECTID 1 (Boundary Road, Hove)
  const [latR, lonR] = bngToOsgb36(526310.64, 105153.173).map(deg);
  const [lon, lat] = bngToLonLat(526310.64, 105153.173, { east: 0, north: 0 });
  const dE = (lon - lonR) * 111320 * Math.cos((latR * Math.PI) / 180), dN = (lat - latR) * 110540;
  assert.ok(dE < -100 && dE > -120, `east shift ${dE}`);
  assert.ok(dN > 55 && dN < 75, `north shift ${dN}`);
});

test('regression for the user report: that bay lands next to Brighton & Hove Plastics, Boundary Road (OSM geocode 50.83218,-0.20754)', () => {
  const [lon, lat] = bngToLonLat(526310.64, 105153.173);
  assert.ok(metres(lon, lat, -0.20754, 50.83218) < 40, `${metres(lon, lat, -0.20754, 50.83218)} m away`);
  // and the old, uncorrected council-served position was 100+ m away
  assert.ok(metres(-0.20617919805, 50.83155294610, -0.20754, 50.83218) > 90);
});
