#!/usr/bin/env bash
# Pasang agent kamera STS Photo Finish di Mac garis finish (sekali saja).
# Hanya agent: tidak butuh Node.js maupun MongoDB.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
echo "=== STS Photo Finish — pasang agent kamera (Mac) ==="

PY=""
for c in python3.13 python3.12 python3.11 python3.10 python3; do
  if command -v "$c" >/dev/null && "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then PY="$c"; break; fi
done
if [ -z "$PY" ]; then
  echo "Butuh Python 3.10 atau lebih baru. Pasang dari https://www.python.org/downloads/ (atau: brew install python@3.12), lalu ulangi."
  exit 1
fi
echo "Python: $($PY -V)"

if [ ! -x agent/.venv/bin/pf-agent ]; then
  echo "Memasang agent (beberapa menit, butuh internet)…"
  "$PY" -m venv agent/.venv
  agent/.venv/bin/pip install -q --upgrade pip
  agent/.venv/bin/pip install -q -e agent
fi
echo "Agent terpasang."

if [ ! -f .env.render ]; then cp .env.render.example .env.render; fi
echo
echo "Langkah berikutnya:"
echo "  1. Isi PF_DEVICE_TOKEN di .env.render (TextEdit terbuka), simpan."
echo "  2. Buka aplikasi Terminal, lalu: open scripts/agent-autostart.command"
echo "     (izinkan akses kamera untuk Terminal bila ditanya)."
echo "  3. Autostart saat login: bash scripts/agent-autostart.sh on"
open -e .env.render 2>/dev/null || true
