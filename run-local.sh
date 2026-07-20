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
import sys
p = sys.argv[1]
html = open(p, encoding="utf-8").read()
tags = [
    '<link rel="stylesheet" href="/achi-theme.css">',
    '<script src="/achi-nav.js?v=8" defer></script>',
]
changed = False
for t in tags:
    if t not in html and "</head>" in html:
        html = html.replace("</head>", t + "</head>", 1)
        changed = True
if changed:
    open(p, "w", encoding="utf-8").write(html)
    print("Injected ACHI theme + nav")
else:
    print("ACHI theme + nav already present")
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
