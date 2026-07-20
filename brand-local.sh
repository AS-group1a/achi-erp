#!/usr/bin/env bash
# Apply ACHI branding (pack + logo + tab title) to a RUNNING local instance.
#
# Run this ONCE per data dir, in a second terminal, AFTER ./run-local.sh is up.
# Branding is stored in the database, so it persists across restarts — you do
# not need to re-run this every boot.
#
# It logs in as the demo admin, applies the partner pack, and sets the logo +
# company name via /api/v1/branding/. Uses the venv's Python (Arch has no python3).
set -euo pipefail

BASE="${BASE:-http://127.0.0.1:8080}"
EMAIL="${EMAIL:-demo@openconstructionerp.com}"
PASSWORD="${PASSWORD:-DemoPass1234!}"
COMPANY_NAME="${COMPANY_NAME:-Achi Scaffolding ERP}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="$HERE/.venv/bin/python"

echo "==> log in"
TOKEN=$(curl -fsS -X POST -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" \
  "$BASE/api/v1/users/auth/login/" | "$PY" -c 'import json,sys;print(json.load(sys.stdin)["access_token"])')

echo "==> rescan + apply partner pack"
curl -fsS -X POST -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/packs/rescan" >/dev/null
curl -fsS -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"slug":"achi-scaffolding","confirm_disables":true}' "$BASE/api/v1/packs/apply" >/dev/null

echo "==> set logo + tab title"
"$PY" - "$BASE" "$TOKEN" "$HERE/packs/achi-scaffolding/logo.png" "$COMPANY_NAME" <<'PY'
import base64, json, sys, urllib.request
base, token, logo, name = sys.argv[1:5]
data_url = "data:image/png;base64," + base64.b64encode(open(logo, "rb").read()).decode()
assert len(data_url) < 4_194_304, f"logo too large: {len(data_url)}"
assert len(name) <= 60
req = urllib.request.Request(f"{base}/api/v1/branding/", method="PUT",
    data=json.dumps({"mode": "logo", "logo_data_url": data_url, "company_name": name}).encode(),
    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
r = json.load(urllib.request.urlopen(req))
print(f"    mode={r['mode']} name={r['company_name']!r} logo={len(r['logo_data_url'] or '')} chars")
PY
echo "OK — refresh the browser."
