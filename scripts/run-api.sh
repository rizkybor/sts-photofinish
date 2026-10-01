#!/usr/bin/env bash
# API + web app (hasil build) dalam mode production (dipanggil PM2).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/api"
if [ ! -f dist/server.js ] || [ ! -f "$ROOT/web/dist/index.html" ]; then
  echo "Belum di-build. Jalankan: npm run build" >&2
  exit 1
fi
export NODE_ENV=production
exec node --env-file="$ROOT/.env" dist/server.js
