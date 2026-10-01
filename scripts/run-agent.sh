#!/usr/bin/env bash
# Capture Agent kamera (dipanggil PM2). Konfigurasi kamera di .env.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/agent"
set -a; source "$ROOT/.env"; set +a
exec .venv/bin/pf-agent
