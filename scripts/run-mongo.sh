#!/usr/bin/env bash
# MongoDB khusus Photo Finish (dipanggil PM2). Data di PF_MONGO_DBPATH
# (default ./data/mongo), port diambil dari PF_MONGO_URL.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
set -a; source "$ROOT/.env"; set +a
DBPATH="${PF_MONGO_DBPATH:-$ROOT/data/mongo}"
PORT="$(echo "${PF_MONGO_URL:-mongodb://127.0.0.1:27018}" | sed -E 's#.*:([0-9]+).*#\1#')"
mkdir -p "$DBPATH"
exec mongod --dbpath "$DBPATH" --port "$PORT" --bind_ip 127.0.0.1
