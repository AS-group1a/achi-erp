#!/usr/bin/env bash
# One-shot: bring up ACHI Scaffolding ERP on a fresh x86-64 host with Docker.
#
#   SITE_ADDRESS=erp.achi.example ./bootstrap.sh        # TLS via Let's Encrypt
#   SITE_ADDRESS=:80              ./bootstrap.sh        # IP-only, no TLS (demo)
#
# ARCH NOTE: x86-64 only. OCE's CAD/BIM converters are amd64-only .debs; on arm64
# (Graviton, Hetzner CAX, Apple silicon) they silently return PLACEHOLDER geometry
# rather than failing. Do not run this on ARM.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

command -v docker >/dev/null || { echo "docker required"; exit 1; }
[ "$(uname -m)" = "x86_64" ] || echo "WARNING: $(uname -m) is not x86_64 — CAD conversion will return placeholder geometry."

if [ ! -f .env ]; then
  echo "==> generating .env with fresh secrets"
  cat > .env <<EOF
SITE_ADDRESS=${SITE_ADDRESS:?set SITE_ADDRESS (domain, or :80 for IP-only)}
OCE_VERSION=11.9.0
POSTGRES_DB=openconstructionerp
POSTGRES_USER=oce
POSTGRES_PASSWORD=$(openssl rand -hex 24)
JWT_SECRET=$(openssl rand -hex 32)
EOF
  chmod 600 .env
  echo "    .env created — BACK THIS UP, it is the only copy of your secrets."
else
  echo "==> .env exists, reusing"
fi

echo "==> build + up"
docker compose up -d --build

echo "==> waiting for health (first boot builds the schema; allow a few minutes)"
for i in $(seq 1 90); do
  if docker compose exec -T app curl -fsS http://127.0.0.1:8080/api/health >/dev/null 2>&1; then
    echo "    healthy after ${i}0s"; break
  fi
  [ "$i" = 90 ] && { echo "    TIMED OUT — docker compose logs app"; exit 1; }
  sleep 10
done

echo "==> installing ACHI pack into the app volume"
# HOME=/data in the image, so ~/.openestimate/packs == /data/.openestimate/packs.
# This is the --data-dir bug workaround: discovery only ever looks here.
docker compose cp ../packs/achi-scaffolding app:/data/.openestimate/packs/achi-scaffolding

cat <<'NEXT'

==> DONE. Remaining manual steps (they need a human decision):

  1. Create the first admin account — the FIRST registrant becomes admin.
     Registration defaults to admin-approve, so do this immediately, before
     the instance is reachable by anyone else.

  2. Apply ACHI branding (needs that admin's JWT):
        TOKEN=<jwt> BASE=https://<your-domain> ../packs/achi-scaffolding/apply-branding.sh

  3. Set up backups. The built-in "backup" module is NOT a backup — it exports
     20 of ~560 tables, scoped to one user. Use pg_dump:
        docker compose exec -T postgres pg_dump -U oce openconstructionerp | gzip > backup.sql.gz
     Put that on cron, off-box, and REHEARSE A RESTORE.

  4. Point an uptime check at /api/health. There is no monitoring in this
     product — no Prometheus, no /metrics, no Sentry.
NEXT
