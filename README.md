# Print Pricer

A browser app for pricing 3D prints.

Live at **[metacrystal.com/printpricer/](https://metacrystal.com/printpricer/)**.

No server, no install, no build step. ES modules served directly from `printpricer/`. Settings and saved quotes persist via `localStorage`, with optional cloud sync (Firebase) and group sharing.

---

## Project layout

```
printpricer/
├── index.html         — page structure
├── css/styles.css     — all styles
└── js/
    ├── main.js        — entry point + DOM glue
    ├── state.js       — constants, defaults, mutable state
    ├── storage.js     — localStorage + cloud-push wrappers
    ├── firebase.js    — auth, group ops, Firestore listeners
    ├── auth-ui.js     — sign-in modal, account pill
    ├── parser.js      — gcode + .3mf + geometry estimator
    ├── spools.js      — Spools layer + refill history
    ├── printers.js    — Printers layer + active picker
    ├── filaments.js   — filament rows + undo
    ├── calc.js        — recalc + cost breakdown
    ├── archive.js     — history, CSV export, clone, print
    ├── activity.js    — group activity feed
    ├── ui.js          — toast, picker overlay, tabs
    └── utils.js       — pure helpers (csv, format, etc.)
```

---

## What it does

Takes the inputs that determine the real cost of a 3D print and gives you a quote you can charge:

- **Filament** — one or more rows (type, grams, $/kg). Multi-color / multi-material prints get a row each.
- **Print time** — hours and minutes.
- **Electricity** — printer wattage × time × your $/kWh rate.
- **Machine / labor time** — hourly rate × time.
- **Failure markup** — % added to cover failed prints.
- **Profit margin** — % added on top.

Everything updates live as you type.

---

## Auto-fill from a project file

Drop a `.gcode`, `.gco`, or `.3mf` file onto the upload zone and it pulls out the print time and per-filament weights so you don't have to type them.

| Slicer | Format | Notes |
|---|---|---|
| PrusaSlicer / OrcaSlicer / SuperSlicer | `.gcode` | Reads `; estimated printing time` and `; filament used [g]` |
| Bambu Studio / OrcaSlicer | `.3mf` (sliced) | Reads `slice_info.config` and `plate_*.json` for prediction time and per-filament `used_g` |
| Bambu Studio / PrusaSlicer | `.gcode.3mf` | Reads the embedded gcode |
| Cura | `.gcode` | Reads `;TIME:` and `;Filament used: 1.23m` (per extruder), converted to grams. Uses `material_diameter` and the material type if the file states them, else 1.75 mm and the **Density** from Defaults (a known material uses its own density: PLA 1.24, PETG 1.27, ABS 1.04, ASA 1.07, TPU 1.21, PC 1.20, nylon 1.14) |
| **Any slicer** | `.3mf` (model-only) | Falls back to **geometry-based estimation** — see below |

Multi-material prints split into separate filament rows automatically. Extruders that used 0 g are left out.

### Geometry-based estimation (model-only 3MFs)

If you drop a 3MF that has no slicing data — a Bambu/Orca project saved before slicing, or a model downloaded from MakerWorld / Printables — Print Pricer falls back to a rough estimate:

1. Parses the meshes from `3D/3dmodel.model` and any `3D/Objects/*.model` files (vertices + triangles; triangles that point at a missing vertex are skipped)
2. Computes the mesh **volume** via the divergence theorem, then counts it once per `<build><item>` on the plate, scaled by the item's `transform` and any `<component transform>`s on the way down (mirrored copies count as positive volume). Objects used only as components are not counted on their own. A file with no `<build>` counts each mesh object once
3. Mass ≈ `volume × density × fill fraction`
4. Time ≈ `mass ÷ throughput`

The toast says "Estimated from geometry — review values" and pre-fills a single filament row labeled "Estimated · adjust if needed". The defaults assume PLA on a typical FDM printer; tune them in **Defaults → Estimate factors**:

| Factor | Default | What it represents |
|---|---|---|
| **Density** | 1.24 g/cm³ | PLA. Use 1.27 for PETG, 1.04 for ABS, 1.21 for TPU |
| **Fill fraction** | 30% | What share of the model's bounding volume is actual plastic (perimeters + infill combined). Lower for hollow prints, higher for solid |
| **Throughput** | 18 g/hr | Filament extrusion rate during a typical print on your printer. Watch a real print, divide grams by hours |

This is an approximation, not a real slicer — accuracy ±30% is normal. For paying customers always slice first. For ballpark personal quoting, it's plenty.

---

## Printer presets

Settings has a printer dropdown that auto-fills typical printing wattage for common models:

- **Bambu Lab** — X1 Carbon, X1E, P1S, P1P, A1, A1 Mini, H2D
- **Prusa** — MK4 / MK4S, MK3S+, Mini+, XL, Core One
- **Creality** — Ender 3 V2, Ender 3 S1, K1 / K1C, K1 Max, K2 Plus
- **Anycubic** — Kobra 2, Kobra 3
- **Elegoo** — Neptune 4, Centauri Carbon
- **Other** — Voron 2.4 / Trident, Sovol SV06 / SV07

Wattage is editable after picking a preset.

---

## How costs are calculated

```
filament    = Σ (grams ÷ 1000 × $/kg)
electricity = (watts ÷ 1000) × hours × $/kWh
time cost   = hours × $/hr
subtotal    = filament + electricity + time cost
failure     = subtotal × failure %
margin      = (subtotal + failure) × margin %
total       = subtotal + failure + margin
```

---

## Spool inventory

The **Spools** layer is a filament library you maintain — each spool tracks:

- Name (e.g. "Polymaker PLA Pro Black")
- Material (PLA / PLA+ / PLA-CF / Silk / Wood / PETG / PETG-CF / ABS / ASA / TPU / PC / Nylon / Other)
- Color (color picker → swatch)
- Cost per kg
- Spool weight (defaults to 1000 g)
- Remaining grams (with low-stock flag below 50 g)
- Optional notes

It links into the **Estimate** sheet: type a spool name in the type/color field (or click **Pick from spools**) and the cost auto-fills. When you **Stamp & Archive** the estimate, grams used are deducted from each linked spool's remaining stock; spools that drop below 50 g get a low-stock toast.

A **Refill** button on the edit form resets a spool's remaining to its full weight when you load a fresh roll.

---

## Multiple printers

The **Printers** layer holds your workshop's fleet — one entry per machine, each with its own:

- Name and optional preset (Bambu, Prusa, Creality, Anycubic, Elegoo, Voron, Sovol)
- **Wattage** — drives the electricity cost on this estimate
- **Hourly rate** — drives the time/labor cost on this estimate
- **Throughput** — used by the geometry estimator (g/hr) when a model-only 3MF is dropped
- **Multi-color overhead** — % added per extra filament beyond the first (AMS / MMU swap + purge)

On the **Estimate** sheet, the **Pick printer** button selects which printer this quote is for. That printer's rates drive the calculation; the printer name is recorded in the **Archive** entry. The active selection is per-device, so different members of a group can default to different machines. The **list** of printers is shared across the group.

If you used Print Pricer before this layer existed, your old single-printer settings (wattage / hourly rate / throughput) auto-migrate into a "My Printer" entry on first load — nothing is lost.

---

## Layers

The app has five numbered layers (tabs):

- **01 — Estimate** — drop file, edit values, see live breakdown, stamp & archive the quote
- **02 — Spools** — filament inventory: track what you have, what's low, what each cost
- **03 — Printers** — workshop fleet: per-machine wattage, hourly rate, throughput, multi-color overhead
- **04 — Defaults** — workspace-wide values: filament cost, electricity rate, failure %, margin %, geometry density / fill fraction
- **05 — Archive** — saved estimates; click Load to bring one back into the calculator

---

## Cloud sync & groups

The app runs in **local mode** by default — everything stays in `localStorage`. To sync across devices and share with family/coworkers using the same printer, set up a Firebase backend (one-time, ~5 min).

### One-time Firebase setup

1. **Create a Firebase project**
   - Go to https://console.firebase.google.com → **Add project**
   - Name it (e.g. `printpricer`), skip Google Analytics, finish.

2. **Enable authentication providers**
   - In the project: **Build → Authentication → Get started**
   - Enable **Email/Password**
   - Enable **Anonymous** (used as the local-mode fallback)

3. **Create the Firestore database**
   - **Build → Firestore Database → Create database**
   - Pick **Production mode** and a region near you, finish.

4. **Apply security rules**
   - Firestore → **Rules** tab → paste the contents of `firestore.rules` (in this repo) → **Publish**.

5. **Register a web app and copy the config**
   - Project settings (gear icon) → **Your apps** → **Web** (`</>` icon)
   - Name it (e.g. `printpricer-web`), register, **copy the `firebaseConfig` object**.

6. **Paste the config into the app**
   - Open `printpricer/js/state.js` and find `export const FIREBASE_CONFIG = { ... }`.
   - Replace its contents with your copied config.
   - Commit and push — deploys automatically.

Whenever `firestore.rules` changes, publish it again (step 4) — the app and the rules must match. For example, products and the activity feed only sync once their rules are published. When an app change and a rules change ship together, deploy the app first, then publish the rules; members on an old cached copy just need to reload. `docs/RULES-REVIEW.md` lists Rules Playground checks to run before publishing.

That's it. The account pill in the top-right will switch from "Local only" to "Local mode" (signed-out cloud) and clicking it opens sign-in.

### How groups work

- Sign in (or create an account) with email + password.
- In **Defaults → Account & Group**, **Create group** (give it a name) — you'll get an 8-char join code like `PR4K-9XMT`. Groups made before codes grew keep their 6-char `PR4-9XK` codes, which still work.
- Share the code with anyone you want in the group. They sign in, paste the code into **Join with code** (dashes and spaces optional), and they're in.
- The code really is the key: only members can see a group, and joining needs the group's *current* code. Codes can't be listed or browsed.
- The group's creator is its owner. Only the owner can **Change join code**: the old code stops working at once, and everyone already in stays in. Do this after removing someone (the owner can remove a member's uid from `members` and `memberEmails` in the Firebase console), or if the code leaked.
- The member list shows each member's email, which is the email of the account they signed in with.
- Once in a group, **spools, printers, products, archive, and defaults are all shared** — everyone sees real-time updates as anyone uses up filament or stamps an estimate. An activity feed records who did what.
- **Leave group** removes you from the group; your local cache stays in your browser. The owner can't leave, since there is no way to hand a group over yet.

### What's shared vs personal

| | Local mode | Signed in (no group) | In a group |
|---|---|---|---|
| Spool inventory | this browser only | this browser only | shared with group, real-time |
| Archive (estimates) | this browser only | this browser only | shared with group, real-time |
| Defaults (printer, $/kWh, rates) | this browser only | this browser only | shared with group, real-time |

Anonymous / signed-out usage works exactly like before — pure `localStorage`.

---

## Tests

The tests use Node's built-in runner (Node 22.15 or later, for `module.registerHooks`) and need no install. The root `package.json` exists only for the test script; the site itself is still plain ES modules with no build step, and the deploy uploads only `printpricer/`.

Run the whole suite from the repo root:

```powershell
npm test
```

Or without npm:

```powershell
node --import ./tests/setup.js --test "tests/**/*.test.js"
```

Run one file:

```powershell
node --import ./tests/setup.js --test tests\parser.test.js
```

Rebuild the `.3mf` fixtures after editing `tests\fixtures\make-3mf.js`:

```powershell
node tests\fixtures\make-3mf.js
```

How it works:

- `tests/setup.js` maps the Firebase CDN imports to `tests/stubs/firebase.js`, drops the `?v=N` query from app imports so tests and app modules share one instance, and provides `JSZip` from `tests/stubs/jszip.js`.
- `tests/helpers/env.js` provides stub DOM elements, `document` and an in-memory `localStorage`. `tests/helpers/reset.js` resets settings and state between tests.
- Known bugs are marked `{ todo: 'BUG: ...' }`. They show as `todo` in the summary and do not fail the run (Node still prints them under "failing tests"). When you fix one, remove its `todo`.
- `checkProductSize`, `computeProductTotals`, `computeProductBreakdown` (products.js) and `forecastSpoolDays` (spools.js) are exported for the tests. Nothing else changed in those files.

---

## Deploy

`.github/workflows/deploy.yml` uploads the `printpricer/` directory to `/home/nstrupp/metacrystal.com/printpricer/` via SFTP on every push to `main` (or from **Run workflow** on the Actions tab). Requires repo secrets `SFTP_USER` and `SFTP_PASSWORD`. The server's SSH host keys are pinned in `.github/known_hosts`; if the host ever changes them, refresh the file with `ssh-keyscan metacrystal.com`.

Module URLs carry a cache-busting `?v=N` query. When you change any JS or CSS file, bump `N` everywhere (`index.html` and every `import` line) so browsers fetch the new files.

The Firebase config is committed in `js/state.js`. Note that Firebase web config is **not secret** — security comes from Firestore rules, which are enforced server-side.

---

## License

Do whatever you want with it.
