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

## The log is the UI; the file is plumbing

Nobody opens a file. A user logs a call:

    Anthony Karam rings about a site in Hazmieh
      -> POST /api/v1/achi/logs/     the only thing a human does
      -> contact found or created    (bridge, deduped by email)
      -> file found or opened        (his open file, else a new one)
      -> log attached

`POST /logs/` is therefore the entry point, not `POST /files/`. The files endpoints
remain for the drawer and for corrections, but the capture path is the log.

**File selection is deliberately dumb**: reuse the contact's most recent OPEN file,
else create one. `new_file=true` forces a fresh one when a known contact rings about
something unrelated. It will occasionally attach a call about a new site to an old
open file — the fix is for the user to say so, not for us to guess by comparing
addresses. The response reports `contact_created` / `file_created` so the UI can
tell the user what happened underneath: files are invisible, not secret.

## The UI

`modules/achi/ui/files.html`, served by our own router at **`/api/v1/achi/ui`**.

Why not a page in OCE's frontend: their UI ships **pre-built inside the pip wheel**
(`app/_frontend_dist`). Adding a page to it means forking the repo and building their
whole frontend ourselves — Node 22, ~8 GB RAM, three.js/Cesium/ag-grid/pdf.js — and
owning that pipeline forever. Measured separately: the *merge* is free (a route added to
`App.tsx` merged 205 upstream commits with **zero conflicts**), but the *build* is not.

Being on the same origin as the SPA is what makes this work: the page reads the JWT the
SPA already stored at `localStorage['oe_access_token']`, so there is no second login.

Known trade-off: **it is not in their sidebar.** A sidebar link needs `App.tsx`, which
needs the frontend build. Bookmark the URL, or take that fork when the pipeline is worth
it. The page is deliberately unauthenticated — it is a static shell containing no data;
every fetch it makes carries the bearer token and is authorised by the API.

Keep `ui/files.html`'s palette in sync with `deploy/overrides/achi-theme.css` by hand.
This page never sees upstream's stylesheet, so the variables can't be shared.

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
