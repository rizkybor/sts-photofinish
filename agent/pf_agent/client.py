"""Koneksi ke Photo Finish API: sinkron jam, terima agent:extract, kirim capture."""
from __future__ import annotations

import logging
import threading
import time
from dataclasses import asdict

import httpx
import socketio

from .clock import OffsetEstimator, now_ns
from .config import AgentConfig
from .extract import ClockSnapshot, ExtractResult, extract
from .ringbuffer import LineRing

log = logging.getLogger(__name__)

SYNC_INTERVAL_S = 2.0
SYNC_BURST = 4
WAIT_FOR_FRAMES_S = 10.0


class AgentClient:
    def __init__(self, cfg: AgentConfig, ring: LineRing) -> None:
        self.cfg = cfg
        self.ring = ring
        self.clock = OffsetEstimator()
        self.sio = socketio.Client(reconnection=True, reconnection_delay_max=5)
        self.http = httpx.Client(base_url=cfg.api_url, headers={"authorization": f"Bearer {cfg.device_token}"}, timeout=10)
        self._stop = threading.Event()
        self.sio.on("connect", lambda: log.info("Terhubung ke API %s", cfg.api_url))
        self.sio.on("disconnect", lambda *_: log.warning("Terputus dari API — mencoba lagi"))
        self.sio.on("agent:extract", self._on_extract)

    def run(self) -> None:
        self.sio.connect(self.cfg.api_url, auth={"token": self.cfg.device_token}, transports=["websocket"], wait_timeout=10)
        threading.Thread(target=self._sync_loop, name="clock-sync", daemon=True).start()
        try:
            self.sio.wait()
        finally:
            self._stop.set()

    # ------------------------------------------------------------ sinkron jam

    def _sync_once(self) -> None:
        t0 = now_ns()
        res = self.sio.call("clock:ping", {}, timeout=2)
        t1 = now_ns()
        if res and res.get("ok"):
            self.clock.add(t0, int(res["serverNs"]), t1)

    def _sync_loop(self) -> None:
        while not self._stop.is_set():
            if self.sio.connected:
                for _ in range(SYNC_BURST):
                    try:
                        self._sync_once()
                    except Exception as err:  # noqa: BLE001 — jaringan lapangan memang tidak stabil
                        log.debug("clock:ping gagal: %s", err)
                if self.clock.ready:
                    best = self.clock.best()
                    log.debug("offset=%.3f ms rtt=%.3f ms", best.offset_ns / 1e6, best.rtt_ns / 1e6)
            self._stop.wait(SYNC_INTERVAL_S)

    # ------------------------------------------------------------ ekstraksi

    def _on_extract(self, req: dict) -> None:
        # Jangan blok thread socket: menunggu frame "post" bisa beberapa detik.
        threading.Thread(target=self._handle_extract, args=(req,), name=f"extract-{req.get('groupId')}", daemon=True).start()

    def _handle_extract(self, req: dict) -> None:
        if req.get("cameraId") != self.cfg.camera_id:
            return
        try:
            if not self.clock.ready:
                raise RuntimeError("Jam belum tersinkron dengan API")
            best = self.clock.best()
            from_ns = self.clock.host_to_agent(int(req["fromHostNs"]))
            to_ns = self.clock.host_to_agent(int(req["toHostNs"]))

            deadline = time.monotonic() + WAIT_FOR_FRAMES_S
            while (self.ring.latest_ns or 0) < to_ns and time.monotonic() < deadline:
                time.sleep(0.05)
            oldest = self.ring.oldest_ns
            if oldest is not None and oldest > from_ns:
                log.warning("Buffer tidak mencakup awal jendela (kurang %.0f ms) — naikkan PF_BUFFER_SECONDS", (oldest - from_ns) / 1e6)

            result = extract(
                self.ring, from_ns, to_ns, self.cfg.captures_dir, req["sessionId"], req["groupId"], self.cfg.camera_id,
                clock=ClockSnapshot.from_request(req.get("clock")), agent_offset_ns=best.offset_ns,
            )
            self._post_capture(req["groupId"], result, best.offset_ns, best.rtt_ns)
            log.info("Capture %s terkirim (%d kolom, %.0f fps)", req["groupId"], result.width, result.fps)
        except Exception:  # noqa: BLE001
            log.exception("Ekstraksi kelompok %s gagal", req.get("groupId"))

    def _post_capture(self, group_id: str, r: ExtractResult, offset_ns: int, rtt_ns: int) -> None:
        d = asdict(r)
        body = {
            "groupId": group_id,
            "cameraId": self.cfg.camera_id,
            "file": d["file"],
            "columnsFile": d["columns_file"],
            "sha256": d["sha256"],
            "columnsSha256": d["columns_sha256"],
            "fps": d["fps"] or 1,
            "width": d["width"],
            "height": d["height"],
            "fromAgentNs": str(d["from_agent_ns"]),
            "toAgentNs": str(d["to_agent_ns"]),
            "agentOffsetNs": str(offset_ns),
            "agentRttNs": str(rtt_ns),
        }
        res = self.http.post("/api/captures", json=body)
        if res.status_code >= 400:
            raise RuntimeError(f"API menolak capture: {res.status_code} {res.text}")
