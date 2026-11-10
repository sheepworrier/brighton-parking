# PLAN.md — Brighton on-street parking finder

> Spikes were run 2026-11-10 from this Mac. Scratch data lives in the session scratchpad, not the repo.

## 1. Context
A personal, no-login, phone-first PWA for finding on-street parking in Brighton & Hove, for me, my girlfriend and a few friends. Static site on GitHub Pages; a scheduled GitHub Action turns the council's ArcGIS data into compact files; a pure-JS engine works out status at a chosen time. Decisions already made: **vanilla ES modules + MapLibre, no build step**; **no permit awareness in the MVP** (revisit later); **unknown hours are shown as "hours unknown, check sign"**, never guessed.

## 2. Spike findings

### 2.1 Reachability / CORS
- FeatureServer reachable from here: `?f=json` 200, `query` works, `outSR=4326&f=geojson` works.
- **CORS: assume the browser cannot call it directly.** A GET with an `Origin` header returned only `Vary: Origin`, with no `Access-Control-Allow-Origin`. The OPTIONS preflight returned `Allow-Methods/Headers` but also no allow-origin. So the client must use our own static files (matches the proposed architecture).
- **GitHub Actions reachability: confirmed 2026-11-10** (run 42834537818, 18 s). Runner got service root 200, all 7 layer counts matched local, paging at offset 2000 returned 2000 features, and the TRO index returned 200. No fallback needed.
- The server sets an `AGS_ROLES` cookie and is IIS/ArcGIS Server: be polite (sequential paging, a User-Agent with a repo URL, no hammering).

### 2.2 Layers (counts are real; geometry sizes are my estimate at 5 dp, gzipped, unsimplified)
| Layer | Geometry | Features | gz geom | Fields (besides OBJECTID/Shape) |
|---|---|---|---|---|
| 57 Paid only | polygon | 147 | 6 KB | MAX_STAY, NO_RETURN, ZONE, **TARIFF**, Pay_By_Phone_Code, Days, Times, Layer |
| 62 Shared permit/paid | polygon | 2143 (**>2000, page**) | 90 KB | MAX_STAY, ZONE, NO_RETURN, LAYER, **TARIFF**, Pay_By_Phone_Code, Times, Days |
| 60 Permit only | polygon | 5464 (**page**) | 226 KB | LAYER, ZONE, **Days, Times** |
| 53 Free limited | polygon | 179 | 8 KB | MAX_STAY, NO_RETURN, ZONE, Days, Times, LAYER |
| 39 Single yellow | **polyline** | 270 | 10 KB | Layer, DAY_FROM/TO, TIME_FROM/TO(+_PM), ZONE, Type, Days, Times |
| 1 Double yellow | **polyline** | 12,158 (**page ×7**) | 432 KB | Layer, ZONE, TIMES ("At Any Time" ×all) |
| 0 Red routes | **polyline** | 35 | 3 KB | Layer, Zone, Times |
| 46 Disabled | polygon | 1850 | 43 KB | MAX_STAY, NO_RETURN, DAY_/TIME_ FROM/TO, ZONE, LAYER, Type |
| 49 EV charging | polygon | 212 | 5 KB | LAYER, ZONE, DAY_/TIME_ cols, MAX_STAY, NO_RETURN, Permit_Or_Shared |
| 54 Loading | polygon | 277 | 7 KB | Layer, MAX_STAY, NO_RETURN, ZONE, Type, Days, Times |
| 55 Motorcycle | polygon | 799 | 16 KB | ZONE, TIMES, Layer |
| 43 Car club | polygon | 111 | 2 KB | ZONE, Times |
| 50 / 51 Event Day B / D | polygon | 1 each | tiny | Layer, a zone letter only |

Unminimised total ≈ **854 KB gzipped geometry**, dominated by double yellows (432 KB) and permit bays (226 KB).

### 2.3 Surprises (these change the plan)
1. **Permit-bay hours ARE in the GIS.** Layer 60 has `Days`/`Times` on every one of its 5464 features, including the odd split windows: zones L, S, X = `11 am to Noon & 6 pm to 7 pm`; W = `10 am to 11 am & 7 pm to 8 pm`; P = `9–10 am & 1–2 pm` Mon–Fri; U = `10–11 am & 5–6 pm` Mon–Fri; 10, 12 other split windows; O = Mon–Sat; E, K, S, X, P, U, 10, 11 = Mon–Fri; most others `Mon to Sun 9 am to 8 pm`. So **`zones.csv` is demoted from "source of hours" to "cross-check + override table"** (see §4).
2. **There is no street-name field on any layer.** "Single yellow on X St" needs a street name from elsewhere → build-time snap of each feature's midpoint to the nearest named OSM way (Overpass/Geofabrik extract, cached in repo). Fallback label: "<Zone> · near <postcode>" via postcodes.io reverse at runtime.
3. **Layers 0, 1, 39 are polylines, not polygons.** Lines must be buffered/styled as lines, and "distance" is to the nearest point on a line.
4. **Single yellow data is poor.** 204 of 270 features have no `Days/Times`; of those, 53 are all `NA` (hours unknown) and many have column shifts (`DAY_FROM='9 AM'`, `DAY_TO='6 PM'`, TIME cols `NA`; one `9 AM`→`6 AM`, 10 rows, probably a typo for 6 PM). Only 270 features city-wide suggests coverage is incomplete. MVP: parse the clean ones, mark the rest "hours unknown".
5. **Layer 53 free limited waiting is mostly outside CPZs** (zone `OUT` 136 of 179), with one `At Any time` and one `10 an to 2 pm & 5 pm to 11 pm`.
6. **Tariff is only a band** (`Low`/`Medium`/`High`, `High-Summer & Low-Winter` ×2, `None` ×1). No prices in the data; link to the council tariff page. `Pay_By_Phone_Code` (location code) is a nice free extra to show for PayByPhone.
7. **The TRO host moved.** `tro.trafficpenaltytribunal.gov.uk/TRO/Brighton%20and%20Hove/` is a 404 page; the old file URLs **redirect to `https://tro.tpt.gov.uk/`**. Index: `https://tro.tpt.gov.uk/brighton-and-hove/`.
8. **The TRO is a moving target.** Base order took effect 4 May 2024; there are already ~15+ amendments in 2026 alone (e.g. Amend No. 6 in force 18 May 2026 on permit allocations/charges; **Amend No. 9 2026 replaces permit bays in zones P and W with exclusive paid parking**; new Zone 14; EV phases). The GIS may lag the legal order, so data freshness is a real accuracy risk, and P/W permit hours in layer 60 may be out of date.
9. **Data hygiene is typical council GIS:** trailing spaces (`'Mon to Sun '`), typos (`Mon toi Sun`, `10 am t 11 am`, `9 amto 8 pm`, `11 am Noon`, `7 pm & 8 pm`), stray junk values (`MAX_STAY='⁶'`, `')'`, Red Route layer values like `Jrjrjrj`), zone `NA`/`None`/`N&R`/`10`/`11`/`12`, 2 `Y` rows with `Sun to Fri & Sat`. Roughly **99%** of time strings in the five main layers fall into ~6 canonical shapes after whitespace/typo normalisation; the remaining <1% should fail loudly or be fixed in the overrides file.
10. **`MAX_STAY='11'` (57) / `11hrs` (62)** is an "all day" cap, not 11 minutes; `NO_RETURN` can be `NA`/`Y`/`24hrs`.
11. **Event Day layers (50, 51) carry no dates**, just a polygon. Event hours (Amex match days etc.) are not in the data.
12. Server returns `exceededTransferLimit` and honours `orderByFields=OBJECTID&resultOffset` paging; `outSR=4326` reprojects server-side.

### 2.4 TRO PDF assessment (Phase 0, done 2026-11-10)
- **Where:** the 2024 order is split into one **"Schedule 1" PDF per zone** (`811…834` = zones A–Z, `835–837` = zones 10, 11, 12) at `https://tro.tpt.gov.uk/TRO/Brighton%20and%20Hove/<n>-CPZ-2024-Schedule-1-Zone-<X>-TRO162024.pdf`, listed on `https://tro.tpt.gov.uk/brighton-and-hove/`. Plus articles (`810`), Schedule 2 permits (`838`), Schedule 3 consolidated orders (`839`). Amendments are separate PDFs (`CPZ-Amend-N-YYYY-…`).
- **Extraction is easy.** Born-digital; `pdftotext -layout` gives clean tables: `Item No | Street Name | Side of Road | Description | CPZ`. Zone Y = 2558 lines, L = 2033, W = 1061, P = 1981.
- **Structure:** each schedule is a list of numbered **Parts whose heading states bay type and hours**, e.g. `Part 4.1 - Permit Parking Places Monday to Sunday - 9am to 8pm`, followed by the street table. So the *street-level* hours are available, and a `zones.csv` is really a `(zone, part, bay type, days, hours)` table plus the street list per part.
- **Verified against layer 60:** Y 4.1 Mon–Sun 9am–8pm; **L 4.7 Mon–Sun 11am–Noon & 6–7pm**; **W 4.6 Mon–Sun 10–11am & 7–8pm**; **P 4.8 Mon–Fri 9–10am & 1–2pm**. All four match the GIS strings exactly.
- **New findings that the GIS lacks:**
  - **Street-level exceptions exist inside a zone.** Zone Y **Part 4.3: Permit Parking Places Mon–Sun 9am–8pm *except 9am–4pm on any Saturday***. This explains the one GIS row `Sun to Fri & Sat / 9 am to 8 pm & 4 pm to 8 pm` (a garbled encoding of the same rule). The parser needs an "except" clause; for now treat as override.
  - **Single yellow hours by street are in the TRO** (e.g. Y Part 1.3 Mon–Sun 9am–6pm, Part 1.4 Mon–Sat 9am–6pm). This is the source for Phase 2 "infer unknown single-yellow hours" and for street names (street list per part), which could replace or cross-check the OSM snap.
  - **Doctors parking places** (Part 7.x, e.g. Mon–Fri 7am–8pm & Sat 7am–1pm), **loading bays with hours**, **Urban Clearways** and **School Entrance markings** exist in the TRO; Doctors bays and clearways are not obviously in the GIS layers we plan to use, so "check the signs" matters.
  - Zone P in the base order still has Permit Parking (4.8); Amendment 9 2026 (TRO-37-2024, `924-CPZ-Amend-9-2026-TRO372024.pdf`) is the one that converts P/W permit bays to paid, so GIS vs TRO drift is checkable right now with the P and W schedules.
- **Verdict:** extraction effort is **low** (mechanical). Seeding the cross-check table is a script + a short review, not an evening of retyping. Scratch copies: session scratchpad `zones/`.

## 3. Architecture (verdict: keep your proposal, with these changes)
- Static GitHub Pages + scheduled Action + pure-JS engine. **Agree.**
- **Change:** CI does *not* parse the TRO PDFs. Hours come from GIS; the TRO PDFs seed a small verified `zones.csv` used only to *cross-check* (CI warning on disagreement) and an `overrides.csv` for known-bad rows.
- **Change:** add a build-time **OSM street snap** (finding 2).
- **Change:** a **weekly TRO-watch** job that fetches `tro.tpt.gov.uk/brighton-and-hove/` and opens a GitHub issue when a new `CPZ-Amend`/`SEA`/`OUT` entry appears, because the legal order outruns the GIS (finding 8).
- Client: **vanilla ES modules + MapLibre GL JS** (CDN pinned, or vendored for offline PWA). OpenFreeMap / OSM raster tiles for the basemap (check usage policy; vendoring tiles is out of scope).
- Supabase: later only. Core never imports it.

## 4. Data model

### 4.1 Normalised feature (one GeoJSON feature)
```jsonc
{ "id": "62-1043",                // layer-objectid, stable
  "k": "shared",                  // kind: paid|shared|permit|limited|sy|dy|red|ev|disabled|loading|moto|carclub
  "zone": "Y",                    // trimmed; "NA"/None -> null; "N&R" kept
  "tariff": "L",                  // H|M|L|HS-LW|null  (paid/shared only)
  "ms": 240, "nr": 240,           // max stay / no return, minutes; null if NA; 1440 = "24hrs"; 11hrs -> 660
  "rules": [ {"d":[1,2,3,4,5,6,7],"w":[["09:00","20:00"]]} ],   // restriction windows; ISO Mon=1
  "always": false,                // true for "At Any Time"
  "unknown": false,               // true when hours can't be derived -> "check sign"
  "pbp": "85295",                 // Pay-by-phone code, string
  "street": "Western Rd",         // from OSM snap, nullable
  "src": "L62" }
```
- Per-layer files, coordinates rounded to 5 dp (~1 m), properties abbreviated, rules **interned** into `rules.json` (there are only ~25 distinct rule sets) so each feature stores an index `r` instead of a rule blob. That is what keeps files small.
- **Rule semantics = "the restricted period":** inside a window the bay type's restriction applies (paid / permit-only / limited waiting / no waiting); outside every window the kerb is unrestricted ("free"). Windows can be multiple per day (`& ` splits) and rules can be several per feature (e.g. Mon–Fri vs Sat).
- Time-string grammar (one regex pipeline): trim → collapse whitespace → fix known typos table → split on `&` → each `H(:MM)? ?(am|pm|Noon) to ...` → minutes; `At Any Time` → `always`. Days: `Mon to Sun|Sat|Fri|Thurs`, `Mon to X & Sat`, abbreviations from `DAY_FROM/TO`. Layer 39 additionally handles the column-shifted rows and the `*_PM` second window, else `unknown:true`.

### 4.2 `zones.csv` and `overrides.csv`
- `zones.csv`: `zone, bay_type, days, hours, street_exceptions, tro_ref, verified_on`. Used **only** for CI cross-check ("GIS says zone P = 9–10 & 1–2; TRO table says paid since Amend 9" → warning/issue).
- `overrides.csv`: `layer, objectid | zone | street, field, value, reason, source`. Applied after parsing, before validation. Fixes the long tail (`9 AM→6 AM`, junk zones) without editing parser code.
- **Seeding** (one-off, ~2 evenings): `pdftotext -layout` each zone schedule from the TRO index; I paste the per-zone permit/pay tables into a Claude session to produce CSV rows; I eyeball them against the sign photos for 3–4 zones. **Keeping current:** the TRO-watch issue (§3) plus a quarterly "diff the CSV vs the latest consolidated order" chore.

## 5. Status engine (`src/engine.js`, pure, no DOM, unit-tested with `node:test`)
Input: `(feature, instant)` → `{status, detail, nextChange, until?}`.
- **Time handling:** convert the instant to Europe/London local parts with `Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',...})`. Never use `getHours()`. Rules are in local wall-clock so BST/GMT is handled for free; test the two transition Sundays (last Sunday of Mar: 01:00 gap; last Sunday of Oct: 01:00–02:00 repeated hour).
- **Per kind**, inside a window / outside:
  - paid: `paid` (max stay, no-return) / `free` (no limit stated; show "check signs")
  - shared: `paid` for visitors (permit holders also OK) / `free`
  - permit: `permit-only` / `free`
  - limited (53): `limited` (max stay, no return) / `free`
  - single yellow: `no-parking` / `free`; unknown → `unknown`
  - double yellow, red route: `no-parking` always; disabled/EV/loading/motorcycle/car club: informational, excluded from "options" list but shown on map toggles
- **nextChange:** scan forward minute-accurate by building the sorted window boundaries for today and the next 7 days, pick the first boundary where status flips; this handles multiple windows per day, week-day gaps (Mon–Fri rule on a Saturday), and rules ending at midnight.
- **Edge cases and decisions:**
  - Overnight ranges (`8 pm to 6 am`): window crossing midnight belongs to the *start* day; supported in the schema; no current data uses it except the suspect `9 AM→6 AM` (flag, don't guess).
  - `At Any Time` → always; no next change.
  - **Sundays:** rules specify Mon-to-Sun/Sat/Fri explicitly, so no special case.
  - **Bank holidays:** unknown whether the TRO exempts them for CPZ hours. **Default assume rules apply on bank holidays** (the usual Brighton position for pay-and-display; verify in the TRO articles) with a config flag `bankHolidays: "apply" | "exempt"` per rule; holiday list from the gov.uk bank-holidays JSON, fetched by the Action and baked into `meta.json`.
  - **Event days:** layers 50/51 are polygons only. MVP: draw them and show a generic notice "Event Day area: extra restrictions on match/event days, check signs". Phase 5: manual `events.json` of dates.
  - **Max stay / no return:** shown as text, not enforced against a planned stay in the MVP. Phase 2: "I'll be here 3 hrs" input hides bays with `ms` < stay, and treats `nr` as "can't re-park within N of leaving".
  - Overlapping features (paid + shared on same kerb): list the cheapest/most permissive first, collapse same-street-same-status into one row.
  - Missing/unknown → status `unknown`, text "Hours unknown — check the sign". Never default to free.
- **Walking distance:** haversine to nearest vertex of the bay/line × 1.25 for a street-grid fudge, labelled `~`. Real routing later.

## 6. Repo layout
```
brighton_parking/
  PLAN.md  README.md  LICENSE(none)  ATTRIBUTION.md
  .github/workflows/data.yml  .github/workflows/tro-watch.yml  .github/workflows/pages.yml
  data-src/zones.csv  data-src/overrides.csv  data-src/typos.json
  scripts/fetch.mjs        # paging, retries, raw -> .cache (gitignored)
  scripts/normalise.mjs    # parse, overrides, street snap, simplify, validate, write
  scripts/validate.mjs     # count/drop checks, unparsed report
  scripts/osm-streets.mjs  # build-time street snap (cached)
  site/index.html  site/app.js  site/engine.js  site/geo.js  site/ui.css
  site/manifest.webmanifest  site/sw.js  site/icons/ (source.jpg + generated PNGs)
  site/data/{paid,shared,permit,limited,sy,dy,red,aux}.geojson  site/data/rules.json  site/data/meta.json
  test/engine.test.mjs  test/parse.test.mjs  test/fixtures/
```
Node 20 scripts, no deps beyond `simplify-geojson`-style tiny helper (Douglas–Peucker, written inline).

## 7. Action workflow (`data.yml`)
- Trigger: `schedule` weekly (Mon 04:00 UTC) + `workflow_dispatch`. Council data changes rarely; nightly is overkill and unfriendly.
- Steps: checkout → `node scripts/fetch.mjs` (sequential, `orderByFields=OBJECTID`, loops `resultOffset` until `exceededTransferLimit` false, 3 retries with backoff, UA `brighton-parking-personal/…`) → `normalise.mjs` → `validate.mjs` → commit only if `site/data` changed (bot commit to `main`, Pages redeploys).
- **Fail loudly (job red + GitHub issue via `gh issue create`):** any time string that fails the grammar after overrides (report layer, OBJECTID, raw value); feature count per layer drops >10% (or >25 absolute for small layers) vs `meta.json`; a layer returns 0; geometry null rate rises; unknown zone letters not in `zones.csv`. On failure, **do not commit**, so the site keeps serving the last good data.
- `meta.json` carries `generated`, per-layer counts and ArcGIS `lastEditDate` (from `?f=json` `editingInfo`), shown in the app footer as "Data: DD Mon YYYY".
- Cost: free tier is plenty (a few minutes/run).

## 8. Data size budget (mobile)
- Target **first load ≤ 250 KB gz of data**, total app shell ≤ 150 KB (+ MapLibre ~200 KB gz from CDN, cached by SW).
- Always-on: paid (57), shared (62), limited (53), single yellow (39), rules ≈ **115 KB gz** at 5 dp, with simplification (tolerance ~0.5 m) probably ~80 KB.
- **Lazy, on demand:** permit (60, 226 KB) loaded when the permit layer toggles on or results need it; double yellow (1, 432 KB) only at zoom ≥ 16 and only as a thin visual layer. If the 12k double-yellows prove too big, tile into 0.01° (~1 km) grid cells and fetch cells near the viewport (Phase 2).
- GitHub Pages serves gzip automatically; use `.geojson` with `Cache-Control` from Pages (10 min) + SW stale-while-revalidate keyed by `meta.json.generated`.

## 9. UI flow (phone-first, one-handed)
- **Layout:** map fills the screen; **bottom sheet** (peek / half / full) holds controls and results; the search bar and time chip live at the *bottom* thumb zone, not the top.
- **Search:** one input. Postcodes (regex `^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$`) → `postcodes.io`; anything else → Nominatim (`viewbox` Brighton bbox, `bounded=1`, 1 req/s, debounced, our referer, results cached in localStorage). "Use my location" button (geolocation, no storage).
- **Time chip:** "Now" by default; tap → quick presets (Now, +1h, Tonight 19:00, Tomorrow 09:00) and a native `<input type="datetime-local">` fallback. Always shown in London time.
- **Map (feature 2):** bays coloured by tariff (High/Med/Low) with a colour-blind-safe ramp **plus** a pattern/outline for permit and limited; tap a bay → popup: tariff, max stay, no return, days, hours, zone, PBP code, "free/paid/permit now" at chosen time.
- **Intelligence list (feature 3):** results within ~600 m of the pin, sorted by walking distance; each row `~210 m · Single yellow, X St · Free now · restriction starts 09:00`; tap row → fly to feature. Filters: hide permit-only, hide paid. Status pills: free / paid / permit-only / no parking / unknown.
- **Footer:** "Data: Brighton & Hove City Council, updated DD Mon" + **"Check the signs"** banner (see §11).
- **PWA:** manifest, 192/512 icons, service worker caching app shell + data; install prompt works on Pixel Chrome. Offline: last data + engine work; geocoding doesn't.

## 10. Phased delivery
**Phase 0 (≈1 h, status: DONE 2026-11-10):** workflow `.github/workflows/phase0-reachability.yml` (manual dispatch) curls the FeatureServer from a GitHub runner, checks counts, paging and the TRO index; poppler installed; zone Y/L/W/P tables extracted and matched to layer 60 (§2.4).
**Phase 1 — weekend MVP (status: DONE 2026-11-10, live at https://sheepworrier.github.io/brighton-parking/):**
1. `fetch` + `normalise` for layers 57, 62, 60, 53, 39 (+1, 0 as plain no-parking lines); typo table + overrides; validation.
2. `engine.js` + unit tests (BST, split windows, Mon–Fri on Saturday, always, unknown).
3. Map + bottom sheet: postcode search, time chip, colour by tariff, popup, nearby list sorted by distance with status and next change.
4. GitHub Pages deploy, PWA manifest + simple SW, disclaimer, attribution.
*Built as:* `scripts/{fetch,normalise,validate}.mjs`, `site/{engine,geo,app}.js`, weekly `data.yml` (opens a `data-failure` issue on failure), `pages.yml`, 31 `node:test` tests. *Not in Phase 1 (moved to Phase 2):* street names, tiling of double yellows, bank-holiday list (rules already apply on bank holidays). *Learned:* 125 of 270 single yellows have unknown hours (shown as "Hours unknown. Check the sign."); 130 tiny double-yellow segments collapse when rounded to 5 dp and are dropped; the list is capped at 30 rows with "Show more"; same-key bays within 50 m are merged into one row.
*Done when:* I can type a postcode, see bays, and the list correctly says e.g. "Zone Y permit bays: free from 20:00".
**Phase 1.1 (done 2026-11-10, from first real use searching for a restaurant):** map shows only paid + shared bays by default, drawn identically and coloured by tariff (green Low / amber Medium / red High, always-visible key); other kinds are category chips (permit, single yellow, limited, double yellow, red routes) that switch the whole layer on; the list leads with paid/shared rows, followed by "Possible free options nearby" sections per category with insight lines ("Permit holders only now, free from 20:00 (in 4 h 57 m)"); tapping a line highlights it on the map, tapping a heading shows all of that category.
**Phase 1.2 (done 2026-11-10):** shareable views. The URL hash carries the search text, origin, planned time, categories and map position (`#q=Unithai&ll=50.82701,-0.16611&l=Unithai&t=2026-11-10T19:00Z&c=pay,permit&v=50.8270,-0.1661,16.5`), kept current with `history.replaceState`, so no server sees it. A Share button uses the phone's share sheet (clipboard fallback). "Now" is never stored, so a link opens at the viewer's now; a stored time already in the past is ignored. "My location" is shared as a coordinate labelled "a location". Logic is in `site/share.js` with tests.
**Phase 2:** street-name snap, weekly TRO-watch issue, `zones.csv` cross-check, stay-length filter, generic event-day notice, tiling for double yellows, bank holiday handling, OSM/Nominatim place search polish.
**Phase 3:** walking-route distance, loading/EV/disabled/motorcycle/car-club toggles. (Share link: done early, see Phase 1.2.)
**Phase 4:** optional "my zone" permit toggle (localStorage, no accounts).
**Phase 5 (last):** event-day dates file (`events.json`) and event-aware status for layers 50/51.
**Later (only if wanted, after Phase 5):** Supabase for favourites / "where I parked" / shared tips; core stays independent.

## 11. Risks and mitigations
| Risk | Mitigation |
|---|---|
| Council data wrong or stale vs the TRO (Amend 9 turns P/W permit bays into paid) | Show data date; weekly TRO-watch issue; overrides file; cross-check CSV; prefer "unknown" over guessing |
| Temporary suspensions, ETROs (e.g. Western Road ETRO 21/2026), roadworks, event days, school-street rules not in data | Persistent "Check the signs" banner on every result and popup; the app is a planning aid, not legal advice |
| Messy strings break the parser | Fail-loudly validation; no silent defaults; typo table |
| Licence unstated | Personal use only, attribute "Contains data from Brighton & Hove City Council", keep repo private or unlisted; do not redistribute as an API; keep ≥1-week fetch cadence; remove on request |
| Rate limits (ArcGIS, Nominatim, postcodes.io, tiles) | One fetch/week; Nominatim ≤1 req/s with debounce + cache + custom Referer; basemap from a provider that allows this traffic |
| FeatureServer blocks Actions IPs | Phase 0 test; fallback: run the fetch locally and commit the output |
| Mobile weight | §8 budget, lazy layers, 5 dp, interned rules |
| Wrong "free" claim causing a ticket | Unknown → "check sign"; no-return/max-stay always printed; never state "free" for kerbs with `always` rules |

## 12. Decisions (answers to the open questions)
1. **Public repo** on GitHub Pages. Attribution and "personal use, no redistribution as an API" wording go in `ATTRIBUTION.md` and the app footer.
2. **Bank holidays are paid** (confirmed from experience): rules apply on bank holidays. Keep the `bankHolidays` flag defaulting to `apply`; still check the TRO articles for any exemption and record the result in `zones.csv`.
3. **Coverage: all of Brighton & Hove.** The §8 budget and lazy-loading/tiling plan stand; double yellows tile in Phase 2.
4. **Event days: last phase** (Phase 5). Until then the generic "Event Day area, check signs" notice only.
5. **"My zone" permit toggle: Phase 4**, immediately before event days.
6. **Basemap:** a free hosted basemap with attribution is fine (OpenFreeMap or OSM raster; check usage policy).
7. **Name: "B&H Parking Finder".** Icon: seagull in a police-style cap beside a blue P sign on a navy rounded square, saved at `site/icons/source.jpg` (2000x2000). Phase 1 task: generate `icon-192.png`, `icon-512.png` and a maskable 512 (the artwork is a rounded square on a dark backdrop, so crop to the square and keep the seagull inside the central 80% safe zone), set `theme_color` to the navy (about `#14305a`) and `name`/`short_name` to "B&H Parking Finder"/"B&H Parking".

## 13. Verification (once built)
- `node --test test/` passes (engine edge cases, parser fixtures with the real typo strings from §2.3).
- Run `fetch` + `normalise` locally; `validate` reports **0 unparsed** after overrides; feature counts match the table in §2.2.
- Serve `site/` locally and check on the Pixel via Chrome remote debugging: Lighthouse PWA pass, installable, data ≤ budget in the Network tab.
- Spot-check 5 real streets on foot/with Street View against the list for free/paid/permit status.
- Trigger `workflow_dispatch` on Actions and confirm the no-change case commits nothing and a seeded bad string turns the job red.
