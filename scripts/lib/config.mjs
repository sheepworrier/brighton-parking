// Shared config for the data pipeline.
export const BASE = 'https://gis.brighton-hove.gov.uk/server/rest/services/Parking/MBTRO/FeatureServer';
export const UA = 'bh-parking-finder-personal (+https://github.com/sheepworrier/brighton-parking)';
export const PAGE = 2000;

// key = output file name (site/data/<key>.geojson); kind = engine kind.
// maxUnknown = how many features may end up with unknown hours before the build fails loudly.
export const LAYERS = {
  57: { key: 'paid',    kind: 'paid',    label: 'Paid Parking Only',            maxUnknown: 3 },
  62: { key: 'shared',  kind: 'shared',  label: 'Shared Permit Or Paid Parking', maxUnknown: 3 },
  60: { key: 'permit',  kind: 'permit',  label: 'Permit Holders Only',          maxUnknown: 3 },
  53: { key: 'limited', kind: 'limited', label: 'Free Limited Waiting',         maxUnknown: 3 },
  39: { key: 'sy',      kind: 'sy',      label: 'Single Yellow Lines',          maxUnknown: 135 },
  1:  { key: 'dy',      kind: 'dy',      label: 'Double Yellow',                maxUnknown: 0 },
  0:  { key: 'red',     kind: 'red',     label: 'Red Routes',                   maxUnknown: 0 },
};

export const COORD_DP = 5;          // ~1 m
export const SIMPLIFY_TOL = 3e-6;   // degrees, ~0.3 m
