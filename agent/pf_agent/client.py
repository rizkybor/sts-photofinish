"""Koneksi ke Photo Finish API: sinkron jam, terima agent:extract, kirim capture."""
from __future__ import annotations

import json
import logging
import queue
import threading
import time
import uuid
from dataclasses import asdict

import httpx
import socketio

from .clock import OffsetEstimator, now_ns
from .config import AgentConfig
from .extract import ClockSnapshot, ExtractResult, extract
from .pipeline import LatestFrame, Pipeline  # noqa: F401 — LatestFrame diekspor ulang untuk kompatibilitas
from .preview import encode_preview
from .scan import scan as scan_cameras
from .settings import CameraSettings

log = logging.getLogger(__name__)

PREVIEW_INTERVAL_S = 0.25  # ±4 fps — cukup untuk mengatur posisi kamera

SYNC_INTERVAL_S = 2.0
SYNC_BURST = 4
WAIT_FOR_FRAMES_S = 10.0


REJECT_GRACE_S = 1.0


class AgentClient:
    def __init__(self, cfg: AgentConfig, pipeline: Pipeline | None = None, env_settings: CameraSettings | None = None) -> None:
        self.cfg = cfg
        self.pipeline = pipeline
        # Pengaturan dari .env — dipakai lagi bila pengaturan web dihapus ("kembalikan ke .env").
        self.env_settings = env_settings or (pipeline.settings if pipeline else None)
        if pipeline is not None:
            pipeline.on_trigger = self.report_trigger
        self._preview_on = threading.Event()
        self._triggers: queue.Queue[int] = queue.Queue(maxsize=100)
        self._boot = str(uuid.uuid4())
        self._trigger_seq = 0
        self.clock = OffsetEstimator()
        self.sio = socketio.Client(reconnection=True, reconnection_delay_max=5)
        self.http = httpx.Client(base_url=cfg.api_url, headers={"authorization": f"Bearer {cfg.device_token}"}, timeout=10)
        self._stop = threading.Event()
        self.sio.on("connect", self._on_connect)
        self.sio.on("disconnect", lambda *_: log.warning("Terputus dari API — mencoba lagi"))
        self.sio.on("agent:extract", self._on_extract)
        self.sio.on("agent:preview", self._on_preview)
        self.sio.on("agent:rejected", self._on_rejected)
        self.sio.on("agent:config", self._on_config)
        self.sio.on("agent:scan", self._on_scan)
        self.rejected: str | None = None

    def run(self) -> None:
        self.sio.connect(self.cfg.api_url, auth={"token": self.cfg.device_token, "cameraId": self.cfg.camera_id}, transports=["websocket"], wait_timeout=10)
        # Tunggu sebentar: API menolak agent kedua untuk kamera yang sama segera
        # setelah connect. Kamera baru dibuka SETELAH itu — agent duplikat tidak
        # pernah merebut kamera dari agent yang sedang berjalan.
        self._stop.wait(REJECT_GRACE_S)
        if self.rejected:
            raise SystemExit(f"Agent ditolak API: {self.rejected}")
        if self.pipeline is not None:
            self.pipeline.run_forever()
            self._send_status()
        threading.Thread(target=self._sync_loop, name="clock-sync", daemon=True).start()
        threading.Thread(target=self._preview_loop, name="preview", daemon=True).start()
        threading.Thread(target=self._trigger_loop, name="trigger", daemon=True).start()
        try:
            self.sio.wait()
        finally:
            self._stop.set()
        if self.rejected:
            raise SystemExit(f"Agent ditolak API: {self.rejected}")

    def _on_rejected(self, data: dict) -> None:
        self.rejected = str((data or {}).get("error") or "ditolak")
        log.error(self.rejected)
        self.sio.disconnect()  # putus manual = tidak mencoba reconnect

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
                # Status berkala: fps terukur terbaru, dan cadangan bila status saat
                # connect terlewat (python-socketio belum "connected" di handler connect).
                self._send_status()
            self._stop.wait(SYNC_INTERVAL_S)

    # ------------------------------------------------------------ photocell virtual

    def report_trigger(self, ts_ns: int) -> None:
        """Dipanggil dari thread kamera — jangan blok; antre lalu kirim di thread lain."""
        try:
            self._triggers.put_nowait(ts_ns)
        except queue.Full:
            log.warning("Antrean pemicu penuh — pemicu dibuang")

    def _trigger_loop(self) -> None:
        while not self._stop.is_set():
            try:
                ts = self._triggers.get(timeout=1.0)
            except queue.Empty:
                continue
            if not self.sio.connected or not self.clock.ready:
                log.warning("Pemicu kamera diabaikan — belum terhubung/tersinkron dengan API")
                continue
            best = self.clock.best()
            self._trigger_seq += 1
            try:
                res = self.sio.call("agent:trigger", {
                    "cameraId": self.cfg.camera_id, "bootId": self._boot, "seq": self._trigger_seq,
                    "agentNs": str(ts), "agentOffsetNs": str(best.offset_ns),
                }, timeout=5)
                if res and res.get("ok"):
                    log.info("Pemicu kamera #%d terkirim%s", self._trigger_seq, "" if res.get("accepted") else " (tidak ada sesi aktif — diabaikan)")
                else:
                    log.warning("Pemicu kamera ditolak: %s", res)
            except Exception as err:  # noqa: BLE001
                log.warning("Pemicu kamera gagal terkirim: %s", err)

    # ------------------------------------------------------------ pengaturan kamera dari web

    def _on_connect(self) -> None:
        # Satu handler per event di python-socketio — log + status di sini.
        log.info("Terhubung ke API %s", self.cfg.api_url)
        self._send_status()

    def _send_status(self) -> None:
        if self.pipeline is None or not self.sio.connected:
            return
        try:
            self.sio.emit("agent:status", {"cameraId": self.cfg.camera_id, **self.pipeline.status()})
        except Exception as err:  # noqa: BLE001
            log.debug("status gagal dikirim: %s", err)

    def _on_config(self, data: dict) -> dict:
        """Terapkan pengaturan dari web (None = kembali ke .env). Balasan = ack ke API."""
        if self.pipeline is None:
            return {"ok": False, "error": "Agent berjalan tanpa kamera"}
        cfg = (data or {}).get("config")
        try:
            base = self.env_settings
            new = base.merged(cfg, self.cfg.buffer_seconds) if cfg else base
        except (ValueError, KeyError, TypeError) as err:
            return {"ok": False, "error": f"Pengaturan tidak valid: {err}"}
        log.info("Menerapkan pengaturan kamera dari web: %s", "kembali ke .env" if not cfg else new.source_type)
        ok, error = self.pipeline.reconfigure(new)
        self._send_status()
        return {"ok": ok, "error": error, "status": self.pipeline.status()}

    def _on_scan(self, _data: dict | None = None) -> dict:
        """Pindai kamera yang terpasang (kamera yang sedang dipakai tidak dibuka ulang)."""
        pipe = self.pipeline
        in_use = pipe.settings.source if pipe and pipe.settings.source.isdigit() else None
        result = scan_cameras(in_use, pipe.size if pipe else None)
        return {"ok": True, **result}

    # ------------------------------------------------------------ cuplikan standby

    def _on_preview(self, req: dict) -> None:
        if req.get("cameraId") != self.cfg.camera_id:
            return
        if req.get("on"):
            self._preview_on.set()
            log.info("Cuplikan standby kamera dimulai")
        else:
            self._preview_on.clear()
            log.info("Cuplikan standby kamera dihentikan")

    def _preview_loop(self) -> None:
        while not self._stop.is_set():
            if not self._preview_on.wait(timeout=1.0) or self.pipeline is None or not self.sio.connected:
                continue
            ts, frame = self.pipeline.latest.get()
            if frame is not None:
                try:
                    line = self.pipeline.finish_line or self.cfg.finish_line
                    self.sio.emit("agent:preview-frame", {
                        "cameraId": self.cfg.camera_id,
                        "agentNs": str(ts),
                        "width": int(frame.shape[1]),
                        "height": int(frame.shape[0]),
                        "fps": round(getattr(self.pipeline.camera, "measured_fps", 0.0), 1),
                        "finishLine": {"x1": line.x1, "y1": line.y1, "x2": line.x2, "y2": line.y2},
                        "jpeg": encode_preview(frame),
                    })
                except Exception as err:  # noqa: BLE001 — cuplikan tidak boleh mengganggu perekaman
                    log.debug("cuplikan gagal: %s", err)
            self._stop.wait(PREVIEW_INTERVAL_S)

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

            pipe = self.pipeline
            ring, archive = pipe.ring, pipe.archive
            deadline = time.monotonic() + WAIT_FOR_FRAMES_S
            while (ring.latest_ns or 0) < to_ns and time.monotonic() < deadline:
                time.sleep(0.05)
            oldest = ring.oldest_ns
            if oldest is not None and oldest > from_ns:
                log.warning("Buffer tidak mencakup awal jendela (kurang %.0f ms) — naikkan PF_BUFFER_SECONDS", (oldest - from_ns) / 1e6)

            frames = None
            if archive is not None:
                archive.flush()
                frames = archive.window(from_ns, to_ns)
            result = extract(
                ring, from_ns, to_ns, self.cfg.captures_dir, req["sessionId"], req["groupId"], self.cfg.camera_id,
                clock=ClockSnapshot.from_request(req.get("clock")), agent_offset_ns=best.offset_ns,
                frames=frames, frame_scale=archive.scale if archive else 1.0, finish_line=pipe.finish_line,
            )
            self._post_capture(req["groupId"], result, best.offset_ns, best.rtt_ns)
            log.info("Capture %s terkirim (%d kolom, %.0f fps, %d frame utuh)", req["groupId"], result.width, result.fps, result.frame_count)
        except Exception:  # noqa: BLE001
            log.exception("Ekstraksi kelompok %s gagal", req.get("groupId"))

    def _upload(self, r: ExtractResult) -> None:
        """Mode VPS: unggah semua file rekaman ke API sebelum didaftarkan.

        Salinan lokal tetap disimpan di laptop lokasi sebagai cadangan bukti.
        Frame utuh diunggah lebih dulu, indeksnya terakhir — API memverifikasi
        hash setiap frame saat rekaman didaftarkan.
        """
        rels: list[str] = []
        if r.frames_file:
            index = json.loads((self.cfg.captures_dir / r.frames_file).read_text())
            rels += [f["file"] for f in index["frames"]]
        rels += [r.file, r.columns_file] + ([r.frames_file] if r.frames_file else [])
        for rel in rels:
            data = (self.cfg.captures_dir / rel).read_bytes()
            for attempt in range(3):
                try:
                    res = self.http.put(f"/api/capture-files/{rel}", content=data, headers={"content-type": "application/octet-stream"}, timeout=30)
                    if res.status_code == 201:
                        break
                    raise RuntimeError(f"{res.status_code} {res.text}")
                except Exception as err:  # noqa: BLE001 — koneksi lokasi bisa putus-sambung
                    if attempt == 2:
                        raise RuntimeError(f"Gagal mengunggah {rel}: {err}") from err
                    time.sleep(1 + attempt)
        log.info("%d file rekaman diunggah ke API", len(rels))

    def _post_capture(self, group_id: str, r: ExtractResult, offset_ns: int, rtt_ns: int) -> None:
        if self.cfg.upload_captures:
            self._upload(r)
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
        if d["frames_file"]:
            body.update({"framesFile": d["frames_file"], "framesSha256": d["frames_sha256"], "frameCount": d["frame_count"]})
        res = self.http.post("/api/captures", json=body)
        if res.status_code >= 400:
            raise RuntimeError(f"API menolak capture: {res.status_code} {res.text}")
