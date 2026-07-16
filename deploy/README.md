# ACHI Scaffolding ERP — production deploy

Stock OpenConstructionERP **11.9.0** + the ACHI partner pack. **No upstream code is modified.**

## Requirements

- **x86-64 Linux host with Docker.** NOT ARM — see the warning below.
- 4 vCPU / 16 GB recommended (2/8 minimum). ~40 GB disk to start.
- A DNS A-record pointing at the box (for TLS).

Indicative: Hetzner CX42-class ≈ $25–40/mo · DigitalOcean ≈ $80–110 · AWS EC2+RDS ≈ $140–190.
Hosting cost is not a meaningful factor here; pick what ops is comfortable with.

## Run

```bash
SITE_ADDRESS=erp.achi.example ./bootstrap.sh     # TLS via Let's Encrypt
SITE_ADDRESS=:80              ./bootstrap.sh     # IP-only demo, no TLS
```

Then follow the four manual steps it prints (admin account, branding, backups, uptime check).

## Why each setting is here

| Setting | Reason |
|---|---|
| `APP_ENV=production` | **Every** shipped upstream artifact leaves this `development` — including `deploy/terraform/digitalocean/main.tf`, which provisions a *public* droplet. It silently disables the JWT gate, the CORS gate, and `/api/docs` hiding. |
| `JWT_SECRET` (32B random) | The one check that refuses to boot. Weak/short + `APP_ENV=production` = hard fail, by design. |
| `HOME=/data` + `appdata` volume | Pack discovery **ignores `--data-dir`** and always resolves `~/.openestimate` (`module_state.py::_resolve_data_dir` — its SQLite branch is dead since v6.6.0). Without this the pack vanishes on container recreate. Same bug class as the §4.8 BIM-geometry data-loss mode. |
| Pinned `OCE_VERSION` | Upstream ships ~2.9 releases/day; 10.9.0 → 11.9.0 in six days. Version numbers carry no compatibility signal. Never track `:latest`. |
| `request_body max_size 2GB` | Upstream requirement — large CAD/PDF uploads. |
| Caddy (not nginx) | Handles the `.mjs` MIME requirement and WebSocket upgrade natively. Get `.mjs` wrong and the pdf.js worker never loads: **the take-off viewer renders blank**. |
| `flush_interval -1` | Pack full-install streams progress over SSE; buffering breaks it. |
| `SEED_DEMO=false` | No demo projects in a real install. |
| `init.sql` | Upstream's own prod compose never mounts it, so `pg_trgm`/`uuid-ossp` are missing there. |

## What this does NOT give you

- **No monitoring.** There is none in the product — no Prometheus, no `/metrics`, no Sentry.
  `/api/health` is well built; point an uptime check at it.
- **No backups.** The built-in `backup` module is not a backup — 20 of ~560 tables, one user's
  own data. Use `pg_dump`, off-box, and **rehearse the restore**.
- **No SSO/OIDC/SAML, no MFA, no multi-tenancy.** Single-tenant is the only shape shipped.
- **No Celery worker.** Jobs fall back to in-process asyncio, so BIM/point-cloud ingest
  competes with request handling. Fine at ACHI's scale; revisit if it bites.

## Upgrading

Bump `OCE_VERSION` in `.env`, `docker compose up -d --build`. Schema is `create_all` +
additive auto-heal — **no down-migrations, no type changes, no rollback.** Snapshot the
database first, every time.

## Status

Constructed from directly verified behaviour (env var names, boot gates, and the data-dir bug
were each checked against the installed 11.9.0 source). **Not yet run end-to-end** — there is
no Docker in the dev container it was written in. Expect to debug the first boot.
