#!/usr/bin/env bash
# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
# Idempotent: local Postgres 16 for Mattermost server tests (mmuser/mostest, db mattermost_test).
set -euo pipefail
PGBIN=/usr/lib/postgresql/16/bin
# Default lives in the postgres user's home: initdb runs as postgres and cannot enter a private $HOME.
DATA="${PGDATA_DIR:-$(getent passwd postgres | cut -d: -f6)/mm-pgdata}"
if [ ! -f "$DATA/PG_VERSION" ]; then
  mkdir -p "$DATA" && chown postgres:postgres "$DATA"
  su postgres -c "$PGBIN/initdb -D '$DATA' -U postgres --auth=trust -E UTF8 --locale=C.UTF-8" >/dev/null
  {
    echo "max_connections = 300"
    echo "fsync = off"                # test-only cluster: speed over durability
    echo "synchronous_commit = off"
  } >> "$DATA/postgresql.conf"
fi
if ! su postgres -c "$PGBIN/pg_ctl -D '$DATA' status" >/dev/null 2>&1; then
  rm -f "$DATA/postmaster.pid"
  su postgres -c "$PGBIN/pg_ctl -D '$DATA' -l '$DATA/server.log' -w -o '-k /tmp -c listen_addresses=localhost' start" >/dev/null
fi
psql -h localhost -U postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='mmuser'" | grep -q 1 \
  || psql -h localhost -U postgres -qc "CREATE ROLE mmuser LOGIN SUPERUSER PASSWORD 'mostest'"
psql -h localhost -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='mattermost_test'" | grep -q 1 \
  || psql -h localhost -U postgres -qc "CREATE DATABASE mattermost_test OWNER mmuser"
echo "postgres ready: $(psql -h localhost -U mmuser -d mattermost_test -tAc 'select version()' | cut -c1-40)"
