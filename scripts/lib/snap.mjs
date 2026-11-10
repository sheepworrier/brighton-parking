// Nearest-road lookup over OSM named ways, plus an alignment check of our bays against those roads.
const LAT0 = 50.83;
const KX = 111320 * Math.cos((LAT0 * Math.PI) / 180), KY = 110574;
export const toXY = (lon, lat) => [lon * KX, lat * KY];
const CELL = 40;

export function buildIndex(ways) {
  const names = [];
  const segs = [];
  const grid = new Map();
  const cell = (x, y) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
  ways.forEach((w, wi) => {
    names.push(w.n);
    for (let i = 1; i < w.g.length; i++) {
      const [x1, y1] = toXY(...w.g[i - 1]), [x2, y2] = toXY(...w.g[i]);
      const id = segs.length;
      segs.push([x1, y1, x2, y2, wi]);
      const minx = Math.floor(Math.min(x1, x2) / CELL), maxx = Math.floor(Math.max(x1, x2) / CELL);
      const miny = Math.floor(Math.min(y1, y2) / CELL), maxy = Math.floor(Math.max(y1, y2) / CELL);
      for (let cx = minx; cx <= maxx; cx++) for (let cy = miny; cy <= maxy; cy++) {
        const k = `${cx},${cy}`;
        (grid.get(k) || grid.set(k, []).get(k)).push(id);
      }
    }
  });
  const segDist = (s, x, y) => {
    const dx = s[2] - s[0], dy = s[3] - s[1], l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((x - s[0]) * dx + (y - s[1]) * dy) / l2)) : 0;
    return Math.hypot(x - (s[0] + t * dx), y - (s[1] + t * dy));
  };
  /** nearest segment within maxD metres: {d, name} or null */
  function nearest(x, y, maxD = 25) {
    const r = Math.ceil(maxD / CELL);
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
    let best = null;
    for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {
      const ids = grid.get(`${cx + i},${cy + j}`);
      if (!ids) continue;
      for (const id of ids) {
        const d = segDist(segs[id], x, y);
        if (d <= maxD && (!best || d < best.d)) best = { d, name: names[segs[id][4]] };
      }
    }
    return best;
  }
  return { nearest };
}

/** Fraction of points within `within` metres of a road when all points are shifted by (dx, dy) metres. */
function fractionNear(index, pts, dx, dy, within) {
  let n = 0;
  for (const [x, y] of pts) if (index.nearest(x + dx, y + dy, within)) n++;
  return n / pts.length;
}

/**
 * Slide our points over the roads to see whether they are systematically offset.
 * pts: [x, y] in metres (toXY). Returns {zero, best, shiftE, shiftN, shiftMetres}.
 */
export function alignment(index, pts, { range = 12, step = 1, within = 4 } = {}) {
  const zero = fractionNear(index, pts, 0, 0, within);
  let best = { f: -1, dx: 0, dy: 0 };
  for (let dx = -range; dx <= range; dx += step) for (let dy = -range; dy <= range; dy += step) {
    const f = fractionNear(index, pts, dx, dy, within);
    // prefer the smaller shift on ties
    if (f > best.f + 1e-9 || (Math.abs(f - best.f) < 1e-9 && Math.hypot(dx, dy) < Math.hypot(best.dx, best.dy))) best = { f, dx, dy };
  }
  return { zero, best: best.f, shiftE: -best.dx, shiftN: -best.dy, shiftMetres: Math.hypot(best.dx, best.dy) };
}

/** Evenly sample up to `max` vertices from GeoJSON features, as metre coordinates. */
export function samplePoints(features, max = 2500) {
  const all = [];
  const walk = (c) => (typeof c[0] === 'number' ? all.push(toXY(c[0], c[1])) : c.forEach(walk));
  features.forEach((f) => walk(f.geometry.coordinates));
  if (all.length <= max) return all;
  const step = all.length / max;
  return Array.from({ length: max }, (_, i) => all[Math.floor(i * step)]);
}
