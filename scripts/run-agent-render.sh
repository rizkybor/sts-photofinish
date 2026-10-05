#!/usr/bin/env bash
# Agent kamera yang tersambung ke API di Render (atau server jarak jauh lain).
# Pengaturan kamera dari .env, lalu .env.render menimpa alamat API, token,
# dan mode unggah. API/MongoDB lokal tidak dijalankan.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/scripts/lib-env.sh"
load_env "$ROOT/.env" || true
if ! load_env "$ROOT/.env.render"; then
  echo "File .env.render belum ada — lihat docs/PANDUAN-RENDER.md bagian 4.1" >&2
  exit 1
fi
if [ -z "${PF_DEVICE_TOKEN:-}" ]; then
  echo "PF_DEVICE_TOKEN di .env.render masih kosong — buat token di Shell Render:" >&2
  echo "  npm run token:device -w api -- agent \"Kamera Finish\"" >&2
  exit 1
fi
echo "Agent kamera → $PF_API_URL"
cd "$ROOT/agent"
exec .venv/bin/pf-agent -v
