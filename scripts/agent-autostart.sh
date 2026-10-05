#!/usr/bin/env bash
# Agent kamera menyala otomatis saat login: on | off | status
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ITEM="$ROOT/scripts/agent-autostart.command"
NAME="agent-autostart.command"

has_item() {
  osascript -e 'tell application "System Events" to get the name of every login item' 2>/dev/null | tr ',' '\n' | sed 's/^ *//' | grep -qx "$NAME"
}

case "${1:-status}" in
  on)
    bash "$ROOT/scripts/run-agent-render.sh" --check-config
    if has_item; then echo "Autostart sudah aktif."; exit 0; fi
    osascript -e "tell application \"System Events\" to make login item at end with properties {path:\"$ITEM\", hidden:false}" >/dev/null
    echo "Autostart AKTIF: agent kamera menyala otomatis setiap kali login ke Mac ini."
    ;;
  off)
    if has_item; then
      osascript -e "tell application \"System Events\" to delete login item \"$NAME\"" >/dev/null
    fi
    echo "Autostart MATI. Agent yang sedang berjalan tidak dihentikan (npm run agent:render:stop)."
    ;;
  status)
    if has_item; then echo "Autostart: AKTIF"; else echo "Autostart: mati"; fi
    ;;
  *)
    echo "Pemakaian: agent-autostart.sh on|off|status" >&2; exit 1 ;;
esac
