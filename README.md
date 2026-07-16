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

| Layer | Mechanism | What it sets |
|---|---|---|
| Partner pack | folder in `~/.openestimate/packs/` | co-brand chip, primary colour, currency, module policy |
| Branding API | `PUT /api/v1/branding/` | browser tab title, in-app logo |

Upgrading OCE = bump `OCE_VERSION` in `.env`, rebuild. No rebase. No conflicts.

> The fork at `ararahxhq-hue/OpenConstructionERP` plays **no part** in this deployment and can
> be retired. It carries only a devcontainer commit; the branding lives here.

## Layout

```
packs/achi-scaffolding/   the pack + apply-branding.sh   (see its README)
deploy/                   Dockerfile, compose, Caddy, bootstrap  (see its README)
```

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
