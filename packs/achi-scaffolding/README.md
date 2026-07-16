# ACHI Scaffolding — OpenConstructionERP partner pack

Brands and configures a **stock, unmodified** OpenConstructionERP install as
*Achi Scaffolding*. Declarative only — no code, no fork, no patched upstream files.

## Contents

| File | Purpose |
|---|---|
| `manifest.json` | Serialized `PartnerPackManifest` — branding, currency, module policy |
| `logo.png` | ACHI mark (512px), served at `GET /api/v1/partner-pack/logo` |
| `favicon.png` | ACHI icon (192px), served at `GET /api/v1/partner-pack/favicon` |
| `onboarding.yaml` | First-login orientation script |
| `apply-branding.sh` | One-shot installer: applies the pack **and** the company branding |

## What it sets

- **Brand**: Achi Scaffolding · primary `#378ADD` · ACHI logo + favicon
- **Currency**: USD (new projects only — existing projects keep theirs)
- **Locale/region**: `en`, Lebanon (`LB`)
- **Enables (17)**: takeoff, dwg_takeoff, cad, crm, subcontractors, contracts,
  equipment, resources, field_time, variations, qms, hse_advanced,
  supplier_catalogs, daily_diary, estimate_rollup, estimate_basis, middle_east_pack
- **Disables (15)**: 8 wrong-continent regional packs (Middle East pack kept),
  accommodation, commissioning, prefab, carbon, esg, architecture_map

## Install

```bash
cp -r achi-scaffolding ~/.openestimate/packs/          # see WARNING below
curl -X POST .../api/v1/packs/rescan     -H "Authorization: Bearer $TOK"
curl -X POST .../api/v1/packs/apply      -H "Authorization: Bearer $TOK" \
     -H 'Content-Type: application/json' \
     -d '{"slug":"achi-scaffolding","confirm_disables":true}'
```

`confirm_disables` is required — the platform never silently disables modules.

## WARNING — upstream bug: `--data-dir` is ignored for packs

Pack discovery does **not** honour `--data-dir`. `app/core/module_state.py::_resolve_data_dir()`
uses an explicit argument, else derives from a *SQLite* `DATABASE_URL`, else falls back to
`~/.openestimate`. SQLite was removed in v6.6.0, so with no argument it **always** returns
`~/.openestimate` — regardless of the flag. `module_states.json` (module enable/disable
persistence) is affected identically.

Packs must therefore live in `~/.openestimate/packs/` for the *service user*, even when the
rest of the data dir is pinned elsewhere. Verify after any deploy or container recreate.

## Two mechanisms, not one

A pack alone does **not** brand everything. The browser tab title and the in-app logo come
from `PUT /api/v1/branding/` (`{mode, logo_data_url, company_name}`) — a runtime **database**
setting the pack does not carry. `apply-branding.sh` does both, so a fresh install is
reproducible.

The SPA computes `document.title` as ``pageName | companyName``, falling back to
`"OpenConstructionERP"` only when `company_name` is empty. Setting it to
`"Achi Scaffolding ERP"` is therefore sufficient — **no core file needs editing.**

Caps worth knowing (both asserted in the script rather than left to fail silently):
- `company_name` — 60 chars max (server-enforced).
- `logo_data_url` — the frontend drops a cached logo over **4,194,304 chars** back to `null`
  on reload. Ours is ~63.8k, well clear.

## Known limits

- **First paint** briefly shows the stock `<title>` from the static `index.html` before React
  boots and applies `company_name`. Cosmetic. Fixing it means editing a core file — i.e.
  starting a fork. Deliberately not done.
- `oe_property_dev` **cannot** be disabled: core `oe_geo_hub` depends on it.
- Co-brand line is the default:
  *"Powered by OpenConstructionERP · In partnership with Achi Scaffolding"* — permitted
  nominative fair use (TRADEMARK.md §2). Overridable via `branding.powered_by_text`.

## Licence / trademark

Upstream is AGPL-3.0. `TRADEMARK.md` §4 **requires** removing or replacing DDC marks from a
modified product's UI and name — this pack does exactly that. "Achi Scaffolding ERP" contains
no DDC mark, so §3 does not apply. §6: retain copyright/licence notices in source files.
§7 (trademark addendum for white-labelling) applies to **commercial-licence** holders — not to
AGPL internal use. Revisit before any deployment outside the company: AGPL §13 and §7 both
become live.

## Verified against

OpenConstructionERP **11.9.0** (PyPI). Pin the version — upstream ships ~2.9 releases/day and
its version numbers carry no compatibility signal.
