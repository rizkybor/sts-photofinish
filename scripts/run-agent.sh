#!/usr/bin/env bash
# Capture Agent kamera (dipanggil PM2). Konfigurasi kamera di .env.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/agent"
source "$ROOT/scripts/lib-env.sh"; load_env "$ROOT/.env"
exec .venv/bin/pf-agent
