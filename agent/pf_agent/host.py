"""Hal-hal di komputer agent: file .env, satu agent per komputer, cegah tidur.

Dipakai agar agent bisa dijalankan langsung (Mac, Windows, Linux) tanpa skrip
bash: `pf-agent --env-file ../.env.render`.
"""
from __future__ import annotations

import atexit
import logging
import os
import re
import socket
import subprocess
import sys
from pathlib import Path

log = logging.getLogger(__name__)

_LINE = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$")

#: Port lokal sebagai kunci "satu agent per komputer" (hanya 127.0.0.1, tidak menerima koneksi).
LOCK_PORT = 47811
#: Kode keluar bila agent lain sudah berjalan — peluncur tidak perlu mencoba lagi.
EXIT_ALREADY_RUNNING = 3


def load_env_file(path: Path) -> None:
    """KEY=VALUE apa adanya (tanda kutip pembungkus dibuang) — sama dengan scripts/lib-env.sh."""
    for raw in path.read_text(encoding="utf-8-sig").splitlines():
        m = _LINE.match(raw)
        if not m:
            continue
        key, val = m.group(1), m.group(2).rstrip("\r")
        q = re.match(r"""^(["'])(.*)\1\s*$""", val)
        os.environ[key] = q.group(2) if q else val


_lock: socket.socket | None = None


def single_instance() -> bool:
    """True bila belum ada agent lain di komputer ini (dua agent = berebut kamera)."""
    global _lock
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    if sys.platform == "win32":
        s.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)  # type: ignore[attr-defined]
    try:
        s.bind(("127.0.0.1", LOCK_PORT))
    except OSError:
        s.close()
        return False
    _lock = s  # dipegang sampai proses selesai
    return True


def keep_awake() -> None:
    """Cegah komputer tidur selama agent berjalan (layar boleh mati)."""
    if sys.platform == "win32":
        import ctypes  # noqa: PLC0415

        es_continuous, es_system_required = 0x80000000, 0x00000001
        ctypes.windll.kernel32.SetThreadExecutionState(es_continuous | es_system_required)  # type: ignore[attr-defined]
        log.info("Komputer dicegah tidur selama agent berjalan")
    elif sys.platform == "darwin":
        try:
            proc = subprocess.Popen(["caffeinate", "-i", "-w", str(os.getpid())])
            atexit.register(proc.terminate)
            log.info("Mac dicegah tidur selama agent berjalan (caffeinate)")
        except OSError:
            pass
