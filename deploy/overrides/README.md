# Tier 3 — CSS overrides

## Why this exists

OpenConstructionERP has **no supported theming API**. Verified against 11.9.0:

- No `theme` / `appearance` / `css` endpoint exists (searched all 2,548 API paths).
- The partner-pack manifest model has **no CSS field**.
- `branding.primary_color` is **dead config**. `MANIFEST_REFERENCE.md` says it "replaces the
  CSS variable `--oe-primary` at boot". That variable appears **0 times in the CSS and 0 times
  in the JS bundle**. Its single use tints one dismissible co-brand chip, falling back to
  `var(--accent)`. It does not theme the app.

So colour changes have exactly two options: inject CSS at the proxy (this), or edit upstream
files (a fork, and a permanent rebase against ~2.9 releases/day). This is the cheaper one.

## How it works

The proxy rewrites `</head>` in the served HTML to append a `<link>` to `/achi-theme.css`.
Because it lands after OpenConstructionERP's own stylesheet, our `:root` block wins on cascade
order. **No upstream file is touched**, so `OCE_VERSION` still upgrades cleanly.

## The theme system

Everything is CSS custom properties in `:root` (light) and `.dark`:

| Variable | Default | Drives |
|---|---|---|
| `--oe-blue` | `#0071e3` | accent: links, focus rings, active nav, gradients |
| `--oe-blue-ch` | `0 113 227` | rgb triplet — Tailwind opacity utilities (`bg-oe-blue/20`) |
| `--oe-bg`, `--oe-bg-secondary` | `#ffffff`, `#f5f5f7` | surfaces, incl. the sidebar |
| `--oe-text-primary/-inverse` | `#1d1d1f` / `#ffffff` | text |
| `--oe-sidebar-width` | `248px` | sidebar width (the only `--oe-*` the JS sets at runtime) |

Override the variable, not the component. Tailwind utilities are generated from these, so one
variable moves everything consistently.

## Do not touch

`--ddc-sig`, `--ddc-origin`, `--__rev-c`, `--__lc-rev` (in `:root`) and `--ddc-author` (set by
JS) are upstream provenance markers. `TRADEMARK.md` §6 requires retaining copyright and
licence notices. Leave them alone.

## Workflow for a change

1. Open the app, DevTools, inspect the element.
2. Find the `--oe-*` variable behind it. If it's a hardcoded Tailwind class instead, target the
   element with a selector — and accept that selector may break on upgrade.
3. Edit `achi-theme.css` only.
4. `docker compose restart caddy` (the file is bind-mounted, no rebuild).
5. Hard-refresh.

## The honest risk

This is **unsupported**. It depends on upstream's internal variable names. `--oe-blue` is
stable-looking and used by 16 rules, so a rename would be a visible upstream refactor rather
than a silent break — but nothing guarantees it. **After every `OCE_VERSION` bump, load the app
and look at it.** A broken override degrades to upstream's default blue, which is ugly but not
dangerous.

Selector-based rules (like the sidebar block) are far more fragile than variable overrides.
Prefer variables. Keep selector hacks few and commented.
