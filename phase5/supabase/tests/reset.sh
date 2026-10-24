#!/bin/bash
# Rebuilds the local test database from scratch: Supabase stand-in, migrations, seed.
# PGHOST/PGPORT point at a local Postgres 16 (see README). Usage: ./reset.sh [dbname]
set -e
DB=${1:-wellbe_test}; DIR=$(cd "$(dirname "$0")/.." && pwd)
export PGUSER=${PGUSER:-postgres} PGHOST=${PGHOST:-/var/lib/postgresql/wbtest} PGPORT=${PGPORT:-5544}
psql -q -d postgres -c "drop database if exists $DB" -c "create database $DB" >/dev/null
for f in "$DIR/tests/00_supabase_stub.sql" "$DIR"/migrations/*.sql "$DIR/seed/seed.sql"; do
  psql -q -v ON_ERROR_STOP=1 -d $DB -f "$f" >/dev/null || { echo "FAILED in $f"; exit 1; }
done
echo "ok: $DB rebuilt"
