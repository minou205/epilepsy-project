import asyncio
import json
import logging
import socket
from typing import Set, List, Dict, Optional, Callable

try:
    import websockets
    WEBSOCKETS_AVAILABLE = True
except ImportError:
    WEBSOCKETS_AVAILABLE = False

from data_handler import EEGDataHandler, CHUNK_SIZE

logger = logging.getLogger(__name__)

WS_HOST    : str   = "0.0.0.0"
WS_PORT    : int   = 8765
INTERVAL_S : float = CHUNK_SIZE / 256.0


def get_local_ip() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"


class PlaybackEngine:

    def __init__(self, handler: EEGDataHandler) -> None:
        self.handler           = handler
        self._position         : int       = 0
        self._paused           : bool      = True
        self._pc_channels      : List[str] = []   # set by the PC GUI
        self._phone_channels   : List[str] = []   # set by the phone SELECT command
        self._active_channels  : List[str] = []   # intersection used for streaming
        self.sequence_id       : int       = 0

    @property
    def current_time(self) -> float:
        return self._position / max(self.handler.sampling_rate, 1)

    @property
    def is_paused(self) -> bool:
        return self._paused

    @property
    def position(self) -> int:
        return self._position

    def seek(self, second: float) -> None:
        self._position = self.handler.second_to_sample(second)

    def pause(self)  -> None: self._paused = True
    def resume(self) -> None: self._paused = False

    def _compute_active(self) -> None:
        """Active channels = intersection of PC and phone selections.
        If only one side has made a selection, use that side's list.
        If neither has selected anything, active is empty (next_chunk falls back to all).
        """
        pc    = self._pc_channels
        phone = self._phone_channels
        if pc and phone:
            phone_set = set(phone)
            self._active_channels = [c for c in pc if c in phone_set]
        elif pc:
            self._active_channels = pc[:]
        elif phone:
            self._active_channels = phone[:]
        else:
            self._active_channels = []

    def set_pc_channels(self, channels: List[str]) -> None:
        """Called from the PC GUI when the user checks/unchecks channels."""
        self._pc_channels = [c for c in channels if c in self.handler.channel_names]
        # Reset phone selection so the phone re-negotiates against the new PC set.
        self._phone_channels = []
        self._compute_active()

    def set_phone_channels(self, channels: List[str]) -> None:
        """Called when the phone sends a SELECT command."""
        # Phone can only request channels the PC has already selected.
        allowed = set(self._pc_channels) if self._pc_channels else set(self.handler.channel_names)
        self._phone_channels = [c for c in channels if c in allowed]
        self._compute_active()

    # Keep old name as a thin alias so existing call-sites still work.
    def set_channels(self, channels: List[str]) -> None:
        self.set_phone_channels(channels)

    def next_chunk(self) -> Optional[Dict]:
        if not self.handler.is_loaded or self._paused:
            return None

        # Stream active channels; fall back to all if no selection has been made
        channels = self._active_channels if self._active_channels else self.handler.channel_names
        if not channels:
            return None

        new_pos, chunk, _ = self.handler.get_chunk(self._position, channels)

        time_s           = round(self._position / self.handler.sampling_rate, 3)
        self._position   = new_pos
        seq              = self.sequence_id
        self.sequence_id += 1

        return {
            "type"   : "data",
            "seq"    : seq,
            "time"   : time_s,
            "labels" : list(chunk.keys()),
            "data"   : [list(v) for v in chunk.values()],
            "fs"     : self.handler.sampling_rate,
        }

    def get_config_packet(self) -> Dict:
        # Report only the PC-selected channels so the phone's channel list
        # mirrors exactly what the user chose on the PC.
        # If no PC selection has been made yet, report all available channels.
        channels = self._pc_channels if self._pc_channels else self.handler.channel_names
        return {
            "type"         : "config",
            "channels"     : channels,
            "duration"     : round(self.handler.duration, 2),
            "samplingRate" : self.handler.sampling_rate,
            "totalSamples" : self.handler.n_samples,
        }


async def _handle_http_probe(connection, request):
    """Return HTTP 200 for plain-HTTP requests (iOS/Android connectivity probes)
    that hit the WebSocket port without a proper WS Upgrade header.
    Returning a response here prevents websockets from logging InvalidUpgrade noise.
    """
    if "websocket" not in request.headers.get("Upgrade", "").lower():
        from websockets.http11 import Response
        from websockets.datastructures import Headers
        body = b"EEG Simulator WS Server\n"
        return Response(200, "OK", Headers([("Content-Length", str(len(body)))]), body)
    return None  # proceed with normal WebSocket handshake


class EEGWebSocketServer:

    def __init__(
        self,
        engine     : PlaybackEngine,
        port       : int                = WS_PORT,
        status_cb  : Optional[Callable] = None,
        command_cb : Optional[Callable] = None,
    ) -> None:
        self.engine      = engine
        self.port        = port
        self._clients    : Set = set()
        self._server     = None
        self.is_running  : bool = False
        self._status_cb  = status_cb
        self._command_cb = command_cb

    async def start(self) -> bool:
        if not WEBSOCKETS_AVAILABLE:
            self._notify("websockets not installed — run: pip install websockets")
            self.is_running = True
            return True

        try:
            self._server = await websockets.serve(
                self._client_handler,
                WS_HOST,
                self.port,
                ping_interval=20,
                ping_timeout=10,
                process_request=_handle_http_probe,
            )
            self.is_running = True
            ip = get_local_ip()
            self._notify(f"Server ready  →  ws://{ip}:{self.port}")
            return True
        except Exception as exc:
            self._notify(f"Server error: {exc}")
            return False

    async def stop(self) -> None:
        self.is_running = False
        if self._server:
            self._server.close()
            await self._server.wait_closed()
        self._clients.clear()
        self._notify("Server stopped")

    async def _client_handler(self, ws, path: str = "/") -> None:
        self._clients.add(ws)
        self._notify(f"iPhone connected  ({len(self._clients)} total)")

        try:
            await ws.send(
                json.dumps(self.engine.get_config_packet(), separators=(",", ":"))
            )
        except Exception as exc:
            logger.warning("Config send failed: %s", exc)

        try:
            async for message in ws:
                await self._dispatch(message)
        except Exception:
            pass
        finally:
            self._clients.discard(ws)
            self._notify(f"iPhone disconnected  ({len(self._clients)} remaining)")

    async def _dispatch(self, raw: str) -> None:
        try:
            msg = json.loads(raw)
            cmd = str(msg.get("cmd", "")).upper()

            if cmd == "GOTO":
                self.engine.seek(float(msg["sec"]))
                self._notify(f"⏩ Seek → {float(msg['sec']):.1f} s")
            elif cmd == "PAUSE":
                self.engine.pause()
                self._notify("⏸ Paused by iPhone")
            elif cmd == "RESUME":
                self.engine.resume()
                self._notify("▶ Resumed by iPhone")
            elif cmd == "SELECT":
                self.engine.set_phone_channels(msg.get("channels", []))
                self._notify(f"Phone selected → {msg.get('channels', [])}")
            else:
                logger.warning("Unknown command: %s", cmd)

            if self._command_cb and cmd in ("PAUSE", "RESUME", "SELECT", "GOTO"):
                self._command_cb(cmd, msg)

        except Exception as exc:
            logger.error("Command error: %s | raw: %.100s", exc, raw)

    async def broadcast_loop(self) -> None:
        while self.is_running:
            packet = self.engine.next_chunk()

            if packet is not None and self._clients:
                msg  = json.dumps(packet, separators=(",", ":"))
                dead : Set = set()

                sends   = [ws.send(msg) for ws in list(self._clients)]
                results = await asyncio.gather(*sends, return_exceptions=True)

                for ws, result in zip(list(self._clients), results):
                    if isinstance(result, Exception):
                        dead.add(ws)
                self._clients -= dead

            await asyncio.sleep(INTERVAL_S)

    async def broadcast_config(self) -> None:
        if not self._clients:
            return
        msg = json.dumps(self.engine.get_config_packet(), separators=(",", ":"))
        for ws in list(self._clients):
            try:
                await ws.send(msg)
            except Exception:
                pass

    async def broadcast_status(self, paused: bool) -> None:
        if not self._clients:
            return
        msg = json.dumps({"type": "status", "paused": paused}, separators=(",", ":"))
        for ws in list(self._clients):
            try:
                await ws.send(msg)
            except Exception:
                pass

    def _notify(self, message: str) -> None:
        logger.info("[Server] %s", message)
        if self._status_cb:
            self._status_cb(message)

    @property
    def client_count(self) -> int:
        return len(self._clients)

    @property
    def server_url(self) -> str:
        ip = get_local_ip()
        return f"ws://{ip}:{self.port}"
