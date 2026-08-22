[1mdiff --git a/brand-local.sh b/brand-local.sh[m
[1mindex b87eb9e..32d7eda 100755[m
[1m--- a/brand-local.sh[m
[1m+++ b/brand-local.sh[m
[36m@@ -14,9 +14,9 @@[m [mEMAIL="${EMAIL:-demo@openconstructionerp.com}"[m
 PASSWORD="${PASSWORD:-DemoPass1234!}"[m
 COMPANY_NAME="${COMPANY_NAME:-Achi Scaffolding ERP}"[m
 HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"[m
[31m-PY="$HERE/.venv/Scripts/python.exe"[m
[32m+[m[32mPY="$HERE/.venv/bin/python"[m
 [m
[31m-INDEX_HTML="$HERE/.venv/Lib/site-packages/app/_frontend_dist/index.html"[m
[32m+[m[32mINDEX_HTML="$("$PY" -c 'import app, pathlib; print(pathlib.Path(app.__file__).parent / "_frontend_dist" / "index.html")')"[m
 [m
 if [ -f "$INDEX_HTML" ]; then[m
   "$PY" - "$INDEX_HTML" <<'PY'[m
