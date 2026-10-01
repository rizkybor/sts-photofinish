#!/usr/bin/env bash
# Persiapan pertama kali di laptop/mini-PC lokasi lomba.
# Aman dijalankan ulang: .env yang sudah ada TIDAK ditimpa.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ok()   { printf "  \033[32m✔\033[0m %s\n" "$1"; }
fail() { printf "  \033[31m✖\033[0m %s\n" "$1"; exit 1; }

echo "1) Memeriksa perangkat lunak"
command -v node >/dev/null && ok "Node $(node -v)" || fail "Node.js ≥ 20 belum terpasang"
command -v python3 >/dev/null && ok "Python $(python3 -V | cut -d' ' -f2)" || fail "Python ≥ 3.10 belum terpasang"
command -v mongod >/dev/null && ok "MongoDB $(mongod --version | head -1 | awk '{print $3}')" || fail "MongoDB (mongod) belum terpasang"

echo "2) Memasang dependensi"
npm install --silent && ok "Paket Node (api, web)"
if [ ! -x agent/.venv/bin/pf-agent ]; then
  python3 -m venv agent/.venv
  agent/.venv/bin/pip install -q -e agent
fi
ok "Capture Agent (agent/.venv)"

echo "3) Konfigurasi"
if [ ! -f .env ]; then
  cp .env.example .env
  for k in PF_JWT_SECRET PF_HMAC_SECRET PF_FILE_URL_SECRET; do
    v="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
    sed -i.bak "s|^$k=.*|$k=$v|" .env
  done
  rm -f .env.bak
  ok ".env dibuat dengan secret acak"
else
  ok ".env sudah ada (tidak diubah)"
fi
mkdir -p data/captures data/mongo && ok "Folder data/"

echo "4) Build web app & API"
npm run build --silent && ok "Build selesai"

cat <<'NEXT'

Selesai. Langkah berikutnya (lihat docs/PANDUAN-DEPLOY.md):
  - Isi kamera & token agent di .env
  - npm run prod:start
  - Buat akun: npm run user:create -w api -- admin admin "Admin"
NEXT
