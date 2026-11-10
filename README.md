# B&H Parking Finder

A small phone-first web app for finding on-street parking in Brighton & Hove: search a postcode or place and a time, see bays on a map coloured by tariff, and get a list of nearby options sorted by distance with their status (free / paid / permit-only / limited waiting / no parking) and **when that status next changes**.

Personal project, no accounts, installable as a PWA. See [PLAN.md](PLAN.md) for the design and the phase plan, and [ATTRIBUTION.md](ATTRIBUTION.md) for data credits and the "check the signs" caveat.

## How it works

- `scripts/fetch.mjs` pages every layer from the council FeatureServer (GeoJSON, WGS84) into `.cache/raw`.
- `scripts/normalise.mjs` parses the free-text Days/Times into compact rules (`[dayMask, fromMin, toMin]`), applies `data-src/typos.json` and `data-src/overrides.csv`, rounds and simplifies geometry, and writes `.cache/out`.
- `scripts/validate.mjs` refuses to publish if anything is unparseable, a layer shrinks >10%, a layer is empty or has too many unknown-hours features. Otherwise it copies to `site/data`.
- `site/engine.js` is a pure status engine (Europe/London time, BST aware). `site/app.js` is the UI (MapLibre, bottom sheet).
- A weekly GitHub Action refreshes the data; a failure opens an issue and leaves the live data untouched.

## Develop

```sh
npm test            # parser, engine and geometry tests
npm run data        # fetch + normalise + validate + publish to site/data
npm run serve       # http://localhost:8080
```

Node 20+. No build step, no runtime dependencies.

## Fixing bad council data

If the weekly run fails on an unparseable string, either add the exact (lower-cased, whitespace-collapsed) string to `data-src/typos.json`, or add a row to `data-src/overrides.csv` (`layer,objectid,field,value,reason`; `field` can be `rules` with a spec like `1-5+7@09:00-20:00;6@09:00-16:00`, Mon=1).
