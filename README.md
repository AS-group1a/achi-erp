# ACHI Scaffolding ERP

Deployment and branding for **Achi Scaffolding ERP**, built on OpenConstructionERP.

## The key decision: we do not fork

OpenConstructionERP is installed **stock from PyPI at a pinned version**. Nothing upstream is
modified. Everything ACHI-specific lives in this repo — 12 files.

```
GitHub (this repo)  ->  branding + deploy config
PyPI                ->  openconstructionerp==11.9.0  (stock, unmodified)
```

Upstream ships ~2.9 releases/day from a single author who does not merge outside pull requests
(README.md:1050). A fork would mean rebasing that forever with no way to contribute back.
Instead we use two supported, declarative extension points:

| Tier | Mechanism | What it sets | Supported? |
|---|---|---|---|
| 1 | Partner pack — folder in `~/.openestimate/packs/` | co-brand chip, currency, module policy | yes |
| 2 | Branding API — `PUT /api/v1/branding/` | browser tab title, in-app logo | yes |
| 3 | CSS override injected at the proxy (`deploy/overrides/`) | colours, theme | **no — see its README** |
| 4 | Editing upstream components | anything else | fork; don't |

> The pack's `branding.primary_color` is **dead config** — the docs claim it replaces
> `--oe-primary`, a variable that does not exist in the bundle. Colour theming is tier 3.

Upgrading OCE = bump `OCE_VERSION` in `.env`, rebuild. No rebase. No conflicts.

> The fork at `ararahxhq-hue/OpenConstructionERP` plays **no part** in this deployment and can
> be retired. It carries only a devcontainer commit; the branding lives here.

## Layout

```
modules/achi/             ACHI's own code — the erp_next_custom equivalent  (see modules/README.md)
packs/achi-scaffolding/   branding pack + apply-branding.sh                 (see its README)
deploy/                   Dockerfile, compose, Caddy, bootstrap             (see its README)
deploy/overrides/         tier-3 CSS theme overrides                        (see its README)
```

**`modules/achi/` is where the team works.** The loader discovers modules on the filesystem,
so our code is a first-class module with its own router, tables and business logic — and
upstream stays stock. Verified live on 11.9.0: router mounted at `/api/v1/achi`, table created.

## Deploy

Requires an **x86-64** host with Docker. Not ARM — OCE's CAD converters are amd64-only `.deb`s
and on ARM silently return *placeholder geometry* instead of failing.

```bash
git clone git@github.com:AS-group1a/achi-erp.git && cd achi-erp/deploy
SITE_ADDRESS=erp.achi.example ./bootstrap.sh     # or <ip>.sslip.io for free TLS without a domain
```

Reference host: Hetzner **CX32** (4 vCPU x86, 8 GB) ≈ €7/mo — the practical minimum, since
OCE ships no Celery worker in production and runs jobs in-process. CX42 (16 GB) if adopted.

## Secrets

`bootstrap.sh` generates the Postgres password and a 32-byte `JWT_SECRET` on the host and
writes `.env` (gitignored, chmod 600). **Nothing secret is committed here.** Back `.env` up —
it is the only copy.

## Status

- Take-off engine verified against a known-answer drawing: returned **exactly 50.0 m²**, and
  **recomputed server-side** when a false quantity was submitted — the client cannot lie about
  a quantity.
- Branding verified end-to-end on a live 11.9.0 instance.
- **The deploy bundle has not yet been run end-to-end** (written without Docker available).
  Expect to debug the first boot.

## Licence

Upstream is AGPL-3.0. `TRADEMARK.md` §4 *requires* replacing DDC marks in a modified product's
UI and name — this pack does exactly that; "Achi Scaffolding ERP" contains no DDC mark. §6:
retain copyright/licence notices in source. §7's white-label addendum applies to
**commercial-licence** holders, not AGPL internal use.

**Revisit before exposing this outside the company** — AGPL §13 and §7 both become live then.
