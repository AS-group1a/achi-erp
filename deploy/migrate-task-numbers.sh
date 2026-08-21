#!/usr/bin/env bash
# One-time migration: replace old UUID-style Team Task codes with TASK-001,
# TASK-002, and so on, ordered by task creation time.
#
# Run from the production server only after taking a database snapshot and
# before deploying the simplified-numbering application commit.

set -euo pipefail

if [[ "${CONFIRM_TASK_RENUMBER:-}" != "YES" ]]; then
  echo "Refusing to renumber task codes without explicit confirmation." >&2
  echo "1. Take a PostgreSQL backup first." >&2
  echo "2. From deploy/, run:" >&2
  echo "   CONFIRM_TASK_RENUMBER=YES bash migrate-task-numbers.sh" >&2
  exit 1
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir"

if ! docker compose ps -q postgres | grep -q .; then
  echo "Postgres is not running. Start the production stack first." >&2
  exit 1
fi

docker compose exec -T postgres psql \
  -v ON_ERROR_STOP=1 \
  -U oce \
  -d openconstructionerp <<'SQL'
BEGIN;

-- Briefly blocks task reads/writes so the unique code constraint stays valid.
LOCK TABLE achi_task IN ACCESS EXCLUSIVE MODE;

CREATE TEMP TABLE achi_task_number_map ON COMMIT DROP AS
SELECT
  id,
  row_number() OVER (ORDER BY created_at ASC, id ASC) AS position
FROM achi_task;

-- Move all existing values out of the final TASK- namespace first. This makes
-- code swaps safe under the table's unique constraint.
UPDATE achi_task AS task
SET task_number = 'REN-' || lpad(mapping.position::text, 24, '0')
FROM achi_task_number_map AS mapping
WHERE task.id = mapping.id;

UPDATE achi_task AS task
SET task_number = 'TASK-' || lpad(
  mapping.position::text,
  greatest(3, length(mapping.position::text)),
  '0'
)
FROM achi_task_number_map AS mapping
WHERE task.id = mapping.id;

SELECT count(*) AS task_codes_renumbered
FROM achi_task;

COMMIT;
SQL
