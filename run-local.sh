#!/usr/bin/env bash
# ACHI ERP — local dev boot (no Docker).
#
# Runs stock OpenConstructionERP from PyPI + our modules/achi + the ACHI theme,
# on an embedded PostgreSQL. This is the DEV path (see the Docker deploy/ for prod).
# Idempotent: safe to re-run. Usage:  ./run-local.sh
set -euo pipefail

OCE_VERSION="${OCE_VERSION:-11.9.0}"
PORT="${PORT:-8080}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

# 0. uv (manages Python 3.12 — Arch's 3.14 breaks the dep tree)
if ! command -v uv >/dev/null 2>&1; then
  export PATH="$HOME/.local/bin:$PATH"
  command -v uv >/dev/null 2>&1 || { echo "Installing uv..."; curl -LsSf https://astral.sh/uv/install.sh | sh; export PATH="$HOME/.local/bin:$PATH"; }
fi

# 1. venv on Python 3.12
[ -x .venv/bin/python ] || uv venv --python 3.12
PY=.venv/bin/python

# 2. install stock OCE if missing
if ! "$PY" -c 'import app' >/dev/null 2>&1; then
  echo "Installing openconstructionerp==$OCE_VERSION (first run, a few minutes)..."
  uv pip install "openconstructionerp==$OCE_VERSION"
fi

APP_DIR="$("$PY" -c 'import app, pathlib; print(pathlib.Path(app.__file__).parent)')"

# 3. inject our module (overwrite so edits to modules/achi take effect on re-run)
rm -rf "$APP_DIR/modules/achi"
cp -r modules/achi "$APP_DIR/modules/achi"
echo "Injected modules/achi -> $APP_DIR/modules/achi"

# 4. inject the ACHI theme (CSS) + sidebar nav (JS), the way Caddy does in prod
DIST="$APP_DIR/_frontend_dist"
cp deploy/overrides/achi-theme.css "$DIST/achi-theme.css"
cp deploy/overrides/achi-nav.js  "$DIST/achi-nav.js"
"$PY" - "$DIST/index.html" <<'PY'
import re, sys
p = sys.argv[1]
html = orig = open(p, encoding="utf-8").read()
NAV_V = "53"
tags = [
    '<link rel="stylesheet" href="/achi-theme.css?v=4">',
    '<script src="/achi-nav.js?v=%s" defer></script>' % NAV_V,
]
# Strip any copy we injected before, INCLUDING an older ?v= cache-buster, then
# re-add the current tags. Matching on the exact tag string instead meant a
# version bump did not recognise the old tag as ours, so it stacked a second
# <script> beside it and achi-nav.js ran twice (two click listeners, two
# MutationObservers) for anyone who had run this script at an earlier version.
html = re.sub(r'<link rel="stylesheet" href="/achi-theme\.css(?:\?v=[^"]*)?"\s*/?>', '', html)
html = re.sub(r'<script src="/achi-nav\.js(?:\?v=[^"]*)?"[^>]*></script>', '', html)
if "</head>" in html:
    html = html.replace("</head>", "".join(tags) + "</head>", 1)
if html != orig:
    open(p, "w", encoding="utf-8").write(html)
    print("Injected ACHI theme + nav (v%s)" % NAV_V)
else:
    print("ACHI theme + nav already present (v%s)" % NAV_V)
PY

# 4a. Re-stamp the service worker's precache entry for index.html.
#
# Without this, none of the ?v= bumps above reach a browser that has already
# loaded the app. sw.js precaches index.html against a fixed revision hash and
# serves EVERY navigation from that copy (NavigationRoute ->
# createHandlerBoundToURL("/index.html")). We rewrite index.html after the
# frontend was built, so the recorded revision still describes the pre-injection
# file and the worker never refetches it. The browser only reinstalls a worker
# when sw.js itself changes byte-for-byte, so writing the real hash in both
# updates the entry and triggers that reinstall.
"$PY" - "$DIST/index.html" "$DIST/sw.js" <<'PY'
import hashlib, pathlib, re, sys
idx, sw = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
if not sw.exists():
    print("No service worker to re-stamp"); raise SystemExit
digest = hashlib.md5(idx.read_bytes()).hexdigest()
js = sw.read_text(encoding="utf-8")
new, n = re.subn(r'(\{url:"index\.html",revision:")[^"]*(")', r'\g<1>%s\g<2>' % digest, js)
if not n:
    print("WARNING: index.html not found in the precache manifest — a stale page may persist")
elif new != js:
    sw.write_text(new, encoding="utf-8")
    print("Re-stamped sw.js precache for index.html (%s)" % digest[:8])
else:
    print("sw.js precache already current (%s)" % digest[:8])
PY

# 4b. install the partner pack (file-level; "apply" happens once via brand-local.sh)
mkdir -p "$HOME/.openestimate/packs"
cp -r packs/achi-scaffolding "$HOME/.openestimate/packs/achi-scaffolding"
echo "Installed pack -> ~/.openestimate/packs/achi-scaffolding"

# 5. run
mkdir -p .rundata
echo ""
echo "================================================================"
echo "  ACHI ERP on http://localhost:$PORT"
echo "  Login: demo@openconstructionerp.com / DemoPass1234!"
echo "  Call Log page: http://localhost:$PORT/api/v1/achi/ui"
echo "  Stop: Ctrl+C"
echo "================================================================"
exec env HOME="$HOME" .venv/bin/openconstructionerp serve \
  --host 127.0.0.1 --port "$PORT" --data-dir "$HERE/.rundata"
