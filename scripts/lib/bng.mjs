// British National Grid (OSGB36 / EPSG:27700) -> WGS84 lat/lon.
//
// WHY THIS EXISTS: the council ArcGIS server's own outSR=4326 reprojection performs NO datum shift. It returns
// OSGB36 geodetic coordinates labelled as WGS84, which puts every feature about 130 m south-east of where it
// really is (found 2026-11-10 from a user report on Boundary Road, confirmed against OpenStreetMap: 99% of
// bays within 6 m of a road after correction vs 34% before). So we fetch native BNG metres and convert here.
//
// Method: BNG -> OSGB36 lat/lon (inverse Transverse Mercator, Airy 1830), then a 7-parameter Helmert
// OSGB36 -> WGS84 (the OS-published parameters negated; accurate to ~5 m), then a small empirical local
// correction (config LOCAL_SHIFT) measured by aligning ~1,150 council bays to OpenStreetMap roads, which
// removed the remaining ~1.5 m systematic east-west residual in Brighton.

const AIRY = { a: 6377563.396, b: 6356256.909 };
const GRS80 = { a: 6378137.0, b: 6356752.3141 };
const F0 = 0.9996012717, LAT0 = (49 * Math.PI) / 180, LON0 = (-2 * Math.PI) / 180, N0 = -100000, E0 = 400000;
const SEC = Math.PI / (180 * 3600);
// OSGB36 -> WGS84 (OS "WGS84 -> OSGB36" parameters, negated)
const H = { tx: 446.448, ty: -125.157, tz: 542.06, s: -20.4894e-6, rx: 0.1502 * SEC, ry: 0.247 * SEC, rz: 0.8421 * SEC };

const e2 = (el) => 1 - (el.b * el.b) / (el.a * el.a);

function meridianArc(phi) {
  const { a, b } = AIRY;
  const n = (a - b) / (a + b);
  return b * F0 * (
    (1 + n + (5 / 4) * n ** 2 + (5 / 4) * n ** 3) * (phi - LAT0)
    - (3 * n + 3 * n ** 2 + (21 / 8) * n ** 3) * Math.sin(phi - LAT0) * Math.cos(phi + LAT0)
    + ((15 / 8) * n ** 2 + (15 / 8) * n ** 3) * Math.sin(2 * (phi - LAT0)) * Math.cos(2 * (phi + LAT0))
    - (35 / 24) * n ** 3 * Math.sin(3 * (phi - LAT0)) * Math.cos(3 * (phi + LAT0)));
}

/** BNG easting/northing (m) -> OSGB36 geodetic [latRad, lonRad]. */
export function bngToOsgb36(E, N) {
  const { a } = AIRY, E2 = e2(AIRY);
  let phi = LAT0, M = 0;
  for (let i = 0; i < 50; i++) {
    phi = (N - N0 - M) / (a * F0) + phi;
    M = meridianArc(phi);
    if (Math.abs(N - N0 - M) < 1e-5) break;
  }
  const s = Math.sin(phi), nu = (a * F0) / Math.sqrt(1 - E2 * s * s), rho = (a * F0 * (1 - E2)) / (1 - E2 * s * s) ** 1.5, eta2 = nu / rho - 1;
  const t = Math.tan(phi), sec = 1 / Math.cos(phi);
  const VII = t / (2 * rho * nu), VIII = (t / (24 * rho * nu ** 3)) * (5 + 3 * t * t + eta2 - 9 * t * t * eta2), IX = (t / (720 * rho * nu ** 5)) * (61 + 90 * t * t + 45 * t ** 4);
  const X = sec / nu, XI = (sec / (6 * nu ** 3)) * (nu / rho + 2 * t * t), XII = (sec / (120 * nu ** 5)) * (5 + 28 * t * t + 24 * t ** 4), XIIA = (sec / (5040 * nu ** 7)) * (61 + 662 * t * t + 1320 * t ** 4 + 720 * t ** 6);
  const dE = E - E0;
  return [phi - VII * dE ** 2 + VIII * dE ** 4 - IX * dE ** 6, LON0 + X * dE - XI * dE ** 3 + XII * dE ** 5 - XIIA * dE ** 7];
}

/** OSGB36 geodetic [latRad, lonRad] -> WGS84 [latDeg, lonDeg] via Helmert. */
export function osgb36ToWgs84(lat, lon) {
  const E2a = e2(AIRY);
  const nu = AIRY.a / Math.sqrt(1 - E2a * Math.sin(lat) ** 2);
  const x = nu * Math.cos(lat) * Math.cos(lon), y = nu * Math.cos(lat) * Math.sin(lon), z = (1 - E2a) * nu * Math.sin(lat);
  const x2 = H.tx + (1 + H.s) * x - H.rz * y + H.ry * z;
  const y2 = H.ty + H.rz * x + (1 + H.s) * y - H.rx * z;
  const z2 = H.tz - H.ry * x + H.rx * y + (1 + H.s) * z;
  const E2b = e2(GRS80), p = Math.hypot(x2, y2);
  let phi = Math.atan2(z2, p * (1 - E2b));
  for (let i = 0; i < 10; i++) {
    const n2 = GRS80.a / Math.sqrt(1 - E2b * Math.sin(phi) ** 2);
    phi = Math.atan2(z2 + E2b * n2 * Math.sin(phi), p);
  }
  return [(phi * 180) / Math.PI, (Math.atan2(y2, x2) * 180) / Math.PI];
}

/** Residual correction in metres (see header). */
export const LOCAL_SHIFT = { east: 1.5, north: 0 };

/** BNG [E, N] -> GeoJSON-order [lon, lat] in WGS84 degrees. */
export function bngToLonLat(E, N, shift = LOCAL_SHIFT) {
  const [la, lo] = osgb36ToWgs84(...bngToOsgb36(E, N));
  const kx = 111320 * Math.cos((la * Math.PI) / 180);
  return [lo + shift.east / kx, la + shift.north / 110540];
}
