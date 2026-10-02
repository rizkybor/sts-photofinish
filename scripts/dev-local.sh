#!/usr/bin/env bash
# Uji lokal STS Photo Finish dengan SATU perintah:
#
#   npm run dev:local               # MongoDB (bila lokal) + API + web + agent kamera
#   npm run dev:local -- --no-agent # tanpa agent kamera
#
# Komponen yang sudah berjalan dipakai ulang (tidak dijalankan dobel).
# Ctrl+C menghentikan semua yang dinyalakan skrip ini. Log: data/logs/*.log
# sts-timingsystem & simulator RaceTime2 dijalankan terpisah (lihat panduan).
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
LOGS="$ROOT/data/logs"
mkdir -p "$LOGS"

WITH_AGENT=1
for arg in "$@"; do
  case "$arg" in
    --no-agent) WITH_AGENT=0 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "Opsi tidak dikenal: $arg (lihat --help)"; exit 1 ;;
  esac
done

# ---------------------------------------------------------------- tampilan
B=$'\033[1m' G=$'\033[32m' Y=$'\033[33m' R=$'\033[31m' C=$'\033[36m' N=$'\033[0m'
step() { printf "\n${B}${C}▶ %s${N}\n" "$1"; }
ok()   { printf "  ${G}✔${N} %s\n" "$1"; }
warn() { printf "  ${Y}!${N} %s\n" "$1"; }
fail() { printf "  ${R}✖ %s${N}\n" "$1"; exit 1; }

# ---------------------------------------------------------------- proses
STARTED=""   # "nama:pid" yang dinyalakan skrip ini
LAST_PID=""

kill_tree() { # hentikan proses beserta anak-anaknya (npm → tsx → node)
  local pid=$1 child
  for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child"; done
  kill "$pid" 2>/dev/null
}

cleanup() {
  [ -z "$STARTED" ] && return
  printf "\n${B}Menghentikan komponen yang dinyalakan skrip ini…${N}\n"
  local entry
  for entry in $STARTED; do
    kill_tree "${entry#*:}"
    wait "${entry#*:}" 2>/dev/null  # tuai proses tanpa pesan "Terminated"
    [ "${entry%%:*}" != "log" ] && printf "  ■ %s\n" "${entry%%:*}"
  done
  STARTED=""
}
trap cleanup EXIT
trap 'exit 130' INT TERM
# Jendela terminal ditutup: tetap bersihkan, agar agent tidak tertinggal "yatim"
# memegang kamera.
trap 'exit 129' HUP

start_bg() { # start_bg <nama> <perintah…> — latar belakang, log ke data/logs/<nama>.log
  # Dipanggil langsung (BUKAN di $(…) / subshell) agar tercatat untuk Ctrl+C.
  local name=$1; shift
  : > "$LOGS/$name.log"
  "$@" >> "$LOGS/$name.log" 2>&1 &
  LAST_PID=$!
  STARTED="$STARTED $name:$LAST_PID"
}

port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
alive() { kill -0 "$1" 2>/dev/null; }

wait_for() { # wait_for <detik> <perintah cek…>
  local secs=$1 i=0; shift
  while [ $i -lt $((secs * 2)) ]; do
    "$@" >/dev/null 2>&1 && return 0
    sleep 0.5; i=$((i + 1))
  done
  return 1
}

# Agent lain yang sedang berjalan — cek PERINTAH proses saja (ps args), bukan
# environment (di macOS `pgrep -f` ikut mencocokkan env seperti `_=…/pf-agent`).
agent_pids() { ps -axo pid=,ppid=,args= | awk '$3 ~ /[Pp]ython[0-9.]*$/ && $4 ~ /pf-agent$/ && ($5 == "" || $5 ~ /^-/) {print $1 ":" $2}'; }
agent_running() { [ -n "$(agent_pids)" ]; }

# ---------------------------------------------------------------- 1. persiapan
step "1. Memeriksa persiapan"
command -v node >/dev/null || fail "Node.js belum terpasang"
[ -f .env ] || fail ".env belum ada — jalankan dulu: npm run setup"
source "$ROOT/scripts/lib-env.sh"; load_env "$ROOT/.env"
for k in PF_JWT_SECRET PF_HMAC_SECRET PF_FILE_URL_SECRET; do
  [ -n "${!k:-}" ] || fail "$k kosong di .env — jalankan: npm run setup"
done
ok ".env lengkap"

if [ ! -d node_modules/fastify ]; then
  warn "Dependensi Node belum terpasang — npm install…"
  npm install --silent || fail "npm install gagal"
fi
ok "Dependensi Node"

if [ $WITH_AGENT -eq 1 ]; then
  if [ ! -x agent/.venv/bin/pf-agent ]; then
    command -v python3 >/dev/null || fail "Python 3 belum terpasang (dibutuhkan agent kamera)"
    warn "Virtualenv agent belum ada — memasang…"
    python3 -m venv agent/.venv && agent/.venv/bin/pip install -q -e agent || fail "Gagal memasang agent"
  fi
  ok "Agent kamera (agent/.venv)"
fi

# ---------------------------------------------------------------- 2. database
step "2. Database"
MONGO_URL="${PF_MONGO_URL:-mongodb://127.0.0.1:27018}"
case "$MONGO_URL" in
  *127.0.0.1*|*localhost*)
    MPORT="$(echo "$MONGO_URL" | sed -E 's#.*:([0-9]+).*#\1#')"
    if port_busy "$MPORT"; then
      ok "MongoDB lokal sudah berjalan di port $MPORT (dipakai ulang)"
    else
      command -v mongod >/dev/null || fail "mongod belum terpasang (atau isi PF_MONGO_URL dengan Atlas)"
      DBPATH="${PF_MONGO_DBPATH:-$HOME/pf-mongo-data}"
      mkdir -p "$DBPATH"
      start_bg mongo mongod --dbpath "$DBPATH" --port "$MPORT" --bind_ip 127.0.0.1
      wait_for 20 port_busy "$MPORT" || { tail -5 "$LOGS/mongo.log"; fail "MongoDB gagal menyala (data/logs/mongo.log)"; }
      ok "MongoDB lokal menyala (port $MPORT, data $DBPATH)"
    fi
    ;;
  *)
    ok "Memakai MongoDB Atlas/jarak jauh (database ${PF_MONGO_DB:-sts_photofinish})"
    ;;
esac

# ---------------------------------------------------------------- 3. API
step "3. API Photo Finish"
API_PORT="${PF_PORT:-4100}"
API_URL="http://127.0.0.1:$API_PORT"
api_up() { curl -sf -m 2 "$API_URL/health" | grep -q '"ok":true'; }
if api_up; then
  ok "API sudah berjalan di $API_URL (dipakai ulang)"
elif port_busy "$API_PORT"; then
  fail "Port $API_PORT dipakai aplikasi lain — hentikan dulu (lsof -iTCP:$API_PORT)"
else
  start_bg api npm run dev:api
  if ! wait_for 45 api_up; then
    tail -15 "$LOGS/api.log"
    fail "API gagal menyala (data/logs/api.log) — sering karena database tidak bisa diakses"
  fi
  ok "API menyala di $API_URL"
fi

# Akun: tawarkan membuat admin bila database belum punya akun sama sekali
USERS=$(cd api && node -e '
  const { MongoClient } = require("mongodb");
  const c = new MongoClient(process.env.PF_MONGO_URL || "mongodb://127.0.0.1:27018", { serverSelectionTimeoutMS: 8000 });
  c.connect().then(() => c.db(process.env.PF_MONGO_DB || "sts_photofinish").collection("pf_users").countDocuments())
    .then((n) => { console.log(n); return c.close(); }).catch(() => console.log("?"));
' 2>/dev/null)
if [ "$USERS" = "0" ]; then
  warn "Belum ada akun pengguna di database ini."
  printf "  Buat akun admin sekarang? [Y/n] "; read -r ans
  case "${ans:-y}" in
    n|N) warn "Lewati — buat nanti: npm run user:create -w api -- admin admin \"Admin\"" ;;
    *) npm run -s user:create -w api -- admin admin "Admin" || warn "Gagal membuat akun" ;;
  esac
elif [ "$USERS" != "?" ]; then
  ok "$USERS akun pengguna tersedia"
fi

# ---------------------------------------------------------------- 4. web
step "4. Web app"
web_up() { curl -sf -m 2 -o /dev/null http://127.0.0.1:5173/; }
if web_up; then
  ok "Web sudah berjalan (dipakai ulang)"
elif port_busy 5173; then
  fail "Port 5173 dipakai aplikasi lain — hentikan dulu (lsof -iTCP:5173)"
else
  start_bg web npm run dev:web
  wait_for 30 web_up || { tail -10 "$LOGS/web.log"; fail "Web gagal menyala (data/logs/web.log)"; }
  ok "Web menyala"
fi

# ---------------------------------------------------------------- 5. agent kamera
AGENT_NOTE="tidak dijalankan"
if [ $WITH_AGENT -eq 1 ]; then
  step "5. Agent kamera"
  if agent_running; then
    warn "Agent kamera lain sudah berjalan — tidak dijalankan lagi (satu kamera = satu agent)"
    for entry in $(agent_pids); do
      # Induk = launchd (1): sisa dari terminal/skrip yang sudah ditutup.
      [ "${entry#*:}" = "1" ] && warn "Agent pid ${entry%%:*} tertinggal dari sesi sebelumnya. Bila kamera bermasalah: ${B}kill ${entry%%:*}${N} lalu jalankan ulang npm run dev:local"
    done
    AGENT_NOTE="agent yang sudah berjalan"
  else
    if [ -z "${PF_DEVICE_TOKEN:-}" ]; then
      warn "PF_DEVICE_TOKEN kosong — membuat token agent…"
      TOKEN="$(npm run -s token:device -w api -- agent "Kamera Lokal" | tail -1)"
      if grep -q '^PF_DEVICE_TOKEN=' .env; then
        sed -i.bak "s|^PF_DEVICE_TOKEN=.*|PF_DEVICE_TOKEN=$TOKEN|" .env && rm -f .env.bak
      else
        printf '\nPF_DEVICE_TOKEN=%s\n' "$TOKEN" >> .env
      fi
      export PF_DEVICE_TOKEN="$TOKEN"
      ok "Token agent dibuat & disimpan di .env"
    fi
    export PF_API_URL="${PF_API_URL:-$API_URL}"
    start_bg agent bash -c 'cd agent && exec .venv/bin/pf-agent -v'
    AGENT_PID=$LAST_PID
    if wait_for 25 grep -q "Terhubung ke API" "$LOGS/agent.log"; then
      AGENT_NOTE="kamera ${PF_CAMERA_SOURCE:-0}"
      ok "Agent terhubung ($AGENT_NOTE)"
      grep -E "Kamera .* buffer|Photocell virtual AKTIF|Arsip frame utuh AKTIF" "$LOGS/agent.log" | sed -E 's/^.*INFO [a-z_.]+: /    /'
    else
      AGENT_NOTE="bermasalah — lihat data/logs/agent.log"
      alive "$AGENT_PID" || tail -6 "$LOGS/agent.log"
      warn "Agent belum terhubung. Cek izin kamera (System Settings → Privacy & Security → Camera),"
      warn "kamera tidak dipakai aplikasi lain, dan PF_CAMERA_SOURCE / PF_DEVICE_TOKEN di .env."
    fi
  fi
fi

# ---------------------------------------------------------------- ringkasan
LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
cat <<EOF

${B}${G}══════════════════  STS Photo Finish siap  ══════════════════${N}
  Web app      : ${B}http://localhost:5173${N}${LAN_IP:+   (tablet/HP: http://$LAN_IP:5173)}
  API          : $API_URL
  Agent kamera : $AGENT_NOTE
  Log          : data/logs/

  Jalankan terpisah bila perlu:
    sts-timingsystem : cd ../sts-timingsystem/app && yarn electron:serve
    Simulator        : npm run sim:timing -w api
${B}${G}═════════════════════════════════════════════════════════════${N}

Menampilkan log API & agent. ${B}Ctrl+C${N} untuk menghentikan semua.

EOF

# ---------------------------------------------------------------- tetap berjalan
# Penampil log di latar + `wait`: bash baru menjalankan trap Ctrl+C setelah
# perintah di depan selesai, sedangkan `wait` langsung terputus oleh sinyal.
touch "$LOGS/api.log" "$LOGS/agent.log"
( tail -n 0 -F "$LOGS/api.log" "$LOGS/agent.log" 2>/dev/null \
  | grep --line-buffered -vE '"msg":"(incoming request|request completed)"|clock:ping|offset=|^==> ' ) 2>/dev/null &
STARTED="log:$! $STARTED"  # penampil log dihentikan paling dulu
wait
