// Coordinate rounding + Douglas-Peucker simplification (degrees; fine at city scale).
function dp(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let max = 0, idx = -1;
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      let d;
      if (len2 === 0) d = Math.hypot(px - ax, py - ay);
      else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      }
      if (d > max) { max = d; idx = i; }
    }
    if (max > tol && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

function roundLine(line, dp_) {
  const k = 10 ** dp_;
  const out = [];
  for (const [x, y] of line) {
    const p = [Math.round(x * k) / k, Math.round(y * k) / k];
    const l = out[out.length - 1];
    if (!l || l[0] !== p[0] || l[1] !== p[1]) out.push(p);
  }
  return out;
}

function ring(r, dpl, tol) {
  const rounded = roundLine(r, dpl);
  const s = dp(rounded, tol);
  const use = s.length >= 4 ? s : rounded;
  return use.length >= 4 ? use : null;
}
function line(l, dpl, tol) {
  const rounded = roundLine(l, dpl);
  const s = dp(rounded, tol);
  const use = s.length >= 2 ? s : rounded;
  return use.length >= 2 ? use : null;
}

/** Returns a cleaned geometry or null if nothing usable is left. */
export function cleanGeometry(g, dpl, tol) {
  if (!g || !g.coordinates || !g.coordinates.length) return null;
  const polys = (rings) => { const r = rings.map((x) => ring(x, dpl, tol)).filter(Boolean); return r.length && r[0] ? r : null; };
  switch (g.type) {
    case 'Polygon': { const c = polys(g.coordinates); return c && { type: 'Polygon', coordinates: c }; }
    case 'MultiPolygon': { const c = g.coordinates.map(polys).filter(Boolean); return c.length ? { type: 'MultiPolygon', coordinates: c } : null; }
    case 'LineString': { const c = line(g.coordinates, dpl, tol); return c && { type: 'LineString', coordinates: c }; }
    case 'MultiLineString': { const c = g.coordinates.map((x) => line(x, dpl, tol)).filter(Boolean); return c.length ? { type: 'MultiLineString', coordinates: c } : null; }
    default: return null;
  }
}
