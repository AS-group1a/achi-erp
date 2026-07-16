#!/usr/bin/env bash
# Apply ACHI branding to a stock OpenConstructionERP install.
#
# Two mechanisms, both supported, neither touching upstream code:
#   1. Partner pack  -> co-brand chip, primary colour, currency, module policy
#   2. /api/v1/branding/ -> browser tab title + in-app logo (a runtime DB setting,
#      NOT carried by the pack, which is why this script exists)
#
# Usage: BASE=https://erp.example.com TOKEN=<jwt> ./apply-branding.sh
set -euo pipefail

BASE="${BASE:-http://127.0.0.1:8080}"
: "${TOKEN:?set TOKEN to an admin JWT}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPANY_NAME="${COMPANY_NAME:-Achi Scaffolding ERP}"   # max 60 chars; drives document.title

echo "==> rescan packs"
curl -fsS -X POST -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/packs/rescan" >/dev/null

echo "==> apply partner pack (confirm_disables required — platform never disables silently)"
curl -fsS -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"slug":"achi-scaffolding","confirm_disables":true}' \
  "$BASE/api/v1/packs/apply" >/dev/null

echo "==> set company branding (tab title + logo)"
python3 - "$BASE" "$TOKEN" "$HERE/logo.png" "$COMPANY_NAME" <<'PY'
import base64, json, sys, urllib.request
base, token, logo, name = sys.argv[1:5]
data_url = "data:image/png;base64," + base64.b64encode(open(logo, "rb").read()).decode()
# Frontend caps the cached logo at 4,194,304 chars (xm*2). Fail loudly rather than
# let it silently drop to null on reload.
assert len(data_url) < 4_194_304, f"logo data-url too large: {len(data_url)}"
assert len(name) <= 60, f"company_name >60 chars: {len(name)}"
req = urllib.request.Request(
    f"{base}/api/v1/branding/", method="PUT",
    data=json.dumps({"mode": "logo", "logo_data_url": data_url, "company_name": name}).encode(),
    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
r = json.load(urllib.request.urlopen(req))
assert r["company_name"] == name, r
print(f"    mode={r['mode']} company_name={r['company_name']!r} logo={len(r['logo_data_url'] or '')} chars")
PY

echo "==> verify"
curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/partner-pack/current" \
  | python3 -c "import sys,json;m=json.load(sys.stdin)['manifest'];print('    pack:',m['partner_name'],'|',m['branding']['primary_color'],'|',m['default_currency'])"
echo "OK"
