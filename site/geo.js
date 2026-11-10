// Geometry helpers for the client: distance from a point to council features, and clustering rows.

export function makeProjector(lat0, lon0) {
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180), ky = 110540;
  return (lon, lat) => [(lon - lon0) * kx, (lat - lat0) * ky];
}

function* lines(geom) {
  switch (geom.type) {
    case 'LineString': yield geom.coordinates; break;
    case 'MultiLineString': yield* geom.coordinates; break;
    case 'Polygon': yield* geom.coordinates; break;
    case 'MultiPolygon': for (const p of geom.coordinates) yield* p; break;
  }
}

function segDist(ax, ay, bx, by) { // distance from origin to segment ab, plus nearest point
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
  const x = ax + t * dx, y = ay + t * dy;
  return { d: Math.hypot(x, y), x, y };
}

/** Distance (m, straight line) from the projector's origin to a feature, nearest point, and vertex centroid (metres). */
export function measure(geom, proj) {
  let best = { d: Infinity, x: 0, y: 0 }, sx = 0, sy = 0, n = 0;
  for (const ring of lines(geom)) {
    let prev = null;
    for (const [lon, lat] of ring) {
      const [x, y] = proj(lon, lat);
      sx += x; sy += y; n++;
      if (prev) { const s = segDist(prev[0], prev[1], x, y); if (s.d < best.d) best = s; }
      else if (Math.hypot(x, y) < best.d) best = { d: Math.hypot(x, y), x, y };
      prev = [x, y];
    }
  }
  return { d: best.d, nx: best.x, ny: best.y, cx: n ? sx / n : 0, cy: n ? sy / n : 0 };
}

/**
 * Find features within `radius` metres of origin and group those with the same key whose centroids
 * are within `link` metres of each other (a run of bays on one kerb becomes one row).
 * features: GeoJSON features; keyFn(feature) -> string. Returns clusters sorted by distance.
 */
export function nearby(features, origin, radius, keyFn, link = 30) {
  const proj = makeProjector(origin.lat, origin.lon);
  const hits = [];
  for (const f of features) {
    const m = measure(f.geometry, proj);
    if (m.d <= radius) hits.push({ f, ...m });
  }
  hits.sort((a, b) => a.d - b.d);
  const clusters = [];
  const byKey = new Map();
  for (const h of hits) {
    const key = keyFn(h.f);
    const list = byKey.get(key) || [];
    let target = null;
    for (const c of list) {
      if (c.items.some((o) => Math.hypot(o.cx - h.cx, o.cy - h.cy) <= link)) { target = c; break; }
    }
    if (!target) { target = { key, items: [], d: h.d, nx: h.nx, ny: h.ny }; list.push(target); byKey.set(key, list); clusters.push(target); }
    target.items.push(h);
  }
  return clusters; // already ordered by first (nearest) member
}

export function metresToLonLat(origin, x, y) {
  const proj = makeProjector(origin.lat, origin.lon);
  const kx = 111320 * Math.cos((origin.lat * Math.PI) / 180);
  void proj;
  return [origin.lon + x / kx, origin.lat + y / 110540];
}

export function haversine(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
