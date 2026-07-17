# ACHI's own code

This is the OpenConstructionERP equivalent of `erp_next_custom`: a place the team writes
ACHI's own features, versioned in this repo, with **upstream left completely stock**.

## How it works

`app/core/module_loader.py` scans `app/modules/*/manifest.py` on the filesystem and
auto-mounts each module's router. Adding a module needs **no edit to any upstream file** —
the backend's best-engineered feature, and the reason this repo can exist.

`deploy/Dockerfile` copies `modules/achi/` into the installed package at build time, then
asserts the loader can see it (so a silent drop fails the build, not production).

## Contract (verified against 11.9.0)

| Rule | Detail |
|---|---|
| Directory name | `manifest.name` minus the `oe_` prefix. `oe_achi` → `modules/achi/` |
| Manifest symbol | **lowercase `manifest`** (`module_loader.py:92`). `MANIFEST` is silently ignored — "No valid manifest" |
| Base import | `from app.database import Base` — **not** `app.core.database` |
| Router | `router.py` exporting `router`; auto-mounted at `/api/v1/achi/` |
| Models | `models.py` auto-imported before `create_all` (`main.py:2503`) |
| Category | **never `core`** — core modules are hard-blocked from being disabled (`module_loader.py:421`) |
| Load order | topological over `depends`; circular deps raise |

`Base` adds `updated_at` automatically — don't declare it.

## Rules for us

**Namespace every table `achi_*`.** Schema is built by `create_all`, not migrations, and drift
is healed additively only (no type changes, no drops, no rollback). A collision with an
upstream `oe_*` table would be painful to unpick.

**Use `optional_depends` for upstream modules** (we depend on `oe_takeoff`, `oe_crm`) so a
disabled upstream module doesn't stop ours loading.

**Never import from upstream modules at module top-level.** Most upstream cross-module imports
are function-local for exactly this reason — a hard import means our module dies when theirs is
disabled.

## Adding a feature

```bash
# 1. write it under modules/achi/
# 2. rebuild + restart
docker compose up -d --build app
# 3. verify
curl -s https://<host>/api/v1/achi/info
```

## Verified live

On 11.9.0: module discovered, router mounted at `/api/v1/achi`, `GET /api/v1/achi/info`
returns, and `achi_scaffold_component` was created in Postgres by `create_all` with its
primary key and unique index.
