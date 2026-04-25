import sys
import os
import asyncio
from io import BytesIO
from typing import List, Dict, Optional

import numpy as np
import pyqtgraph as pg
from PyQt5.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
    QGroupBox, QPushButton, QLabel, QFileDialog, QSlider, QListWidget,
    QListWidgetItem, QSplitter, QTextEdit, QDoubleSpinBox,
    QFrame, QMenu, QColorDialog,
)
from PyQt5.QtCore import Qt, QTimer, pyqtSlot
from PyQt5.QtGui  import QFont, QPixmap, QColor, QIcon
import qasync

from data_handler     import EEGDataHandler
from websocket_server import EEGWebSocketServer, PlaybackEngine

try:
    import qrcode as qrcode_lib
    QR_AVAILABLE = True
except ImportError:
    QR_AVAILABLE = False


DISPLAY_SECS   = 5
BUFFER_SAMPLES = 256 * DISPLAY_SECS
CHANNEL_OFFSET = 150
MAX_DISPLAY_CH = 18

CHANNELS_9 = [
    'FP1-F7', 'F7-T7',
    'FP2-F8', 'F8-T8',
    'FP1-F3', 'F3-C3',
    'FP2-F4', 'F4-C4',
    'FZ-CZ',
]

CHANNELS_18 = [
    'FP1-F7', 'F7-T7', 'T7-P7', 'P7-O1',
    'FP2-F8', 'F8-T8', 'T8-P8', 'P8-O2',
    'FP1-F3', 'F3-C3', 'C3-P3', 'P3-O1',
    'FP2-F4', 'F4-C4', 'C4-P4', 'P4-O2',
    'FZ-CZ',  'CZ-PZ',
]

CHANNEL_COLORS = [
    "#00FF88", "#FF6644", "#4499FF", "#FFCC00",
    "#FF44CC", "#44FFFF", "#AAFF44", "#FF8833",
    "#CC44FF", "#44FFCC",
    "#FF3366", "#33CCFF", "#FFAA00", "#AA44FF",
    "#00FFCC", "#FF6600", "#88FF00", "#FF0099",
]

BG_DARK  = "#0A0A1A"
BG_PANEL = "#0D0D22"


def make_qr_pixmap(text: str, size: int = 180) -> Optional[QPixmap]:
    if not QR_AVAILABLE:
        return None
    qr = qrcode_lib.QRCode(
        version=1,
        error_correction=qrcode_lib.constants.ERROR_CORRECT_L,
        box_size=6,
        border=3,
    )
    qr.add_data(text)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white")
    buf = BytesIO()
    img.save(buf, format="PNG")
    pixmap = QPixmap()
    pixmap.loadFromData(buf.getvalue())
    return pixmap.scaled(size, size, Qt.KeepAspectRatio, Qt.SmoothTransformation)


def fmt_time(seconds: float) -> str:
    m = max(0, int(seconds)) // 60
    s = max(0, int(seconds)) % 60
    return f"{m:02d}:{s:02d}"


def _vline(layout: QHBoxLayout) -> None:
    sep = QFrame()
    sep.setFrameShape(QFrame.VLine)
    sep.setFrameShadow(QFrame.Sunken)
    layout.addWidget(sep)


class EEGMainWindow(QMainWindow):

    def __init__(self) -> None:
        super().__init__()

        self.data_handler = EEGDataHandler()
        self.engine       = PlaybackEngine(self.data_handler)
        self.ws_server    = EEGWebSocketServer(
            self.engine,
            status_cb  = self._on_ws_status,
            command_cb = self._on_phone_command,
        )

        self.streaming        : bool      = False
        self._server_task                 = None
        self.selected_chs     : List[str] = []
        self.pc_curves        : List[pg.PlotCurveItem] = []
        self.ch_text_items    : List[pg.TextItem]      = []
        self._slider_dragging : bool      = False
        self.channel_colors   : Dict[str, str] = {}
        self._pc_preview_enabled : bool   = True

        self._build_ui()
        self._apply_theme()

        self._ui_timer = QTimer(self)
        self._ui_timer.setInterval(62)
        self._ui_timer.timeout.connect(self._refresh_ui)

        QTimer.singleShot(100, self._schedule_server_start)

    @pyqtSlot()
    def _schedule_server_start(self) -> None:
        self._server_task = asyncio.ensure_future(self._server_lifecycle())

    async def _server_lifecycle(self) -> None:
        ok = await self.ws_server.start()
        if not ok:
            self._append_log("⚠ Server failed to start — check port 8765 is free")
            return

        url = self.ws_server.server_url
        QTimer.singleShot(0, lambda: self._show_qr(url))
        self._append_log(f"✓ Server listening — scan QR or open {url}")

        await self.ws_server.broadcast_loop()

    def _build_ui(self) -> None:
        self.setWindowTitle("EEG Simulator")
        self.setMinimumSize(1100, 700)
        self.resize(1380, 840)

        _logo = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'logo.png')
        if os.path.exists(_logo):
            self.setWindowIcon(QIcon(_logo))

        central = QWidget()
        self.setCentralWidget(central)
        root = QVBoxLayout(central)
        root.setContentsMargins(8, 8, 8, 8)
        root.setSpacing(6)

        root.addWidget(self._build_controls())

        splitter = QSplitter(Qt.Horizontal)
        splitter.addWidget(self._build_plot_area())
        splitter.addWidget(self._build_right_panel())
        splitter.setStretchFactor(0, 3)
        splitter.setStretchFactor(1, 1)
        root.addWidget(splitter, stretch=1)

        root.addWidget(self._build_seek_bar())

    def _build_controls(self) -> QGroupBox:
        box = QGroupBox("Playback Controls")
        box.setMaximumHeight(72)
        row = QHBoxLayout(box)
        row.setSpacing(10)

        self.btn_load = QPushButton("📂  Load EDF File")
        self.btn_load.setFixedHeight(36)
        self.btn_load.setMinimumWidth(150)
        self.btn_load.clicked.connect(self._on_load)
        row.addWidget(self.btn_load)

        _vline(row)

        row.addWidget(QLabel("Start at:"))
        self.spin_start = QDoubleSpinBox()
        self.spin_start.setRange(0, 0)
        self.spin_start.setSingleStep(1.0)
        self.spin_start.setDecimals(1)
        self.spin_start.setSuffix(" s")
        self.spin_start.setFixedWidth(90)
        self.spin_start.setFixedHeight(34)
        self.spin_start.setEnabled(False)
        self.spin_start.setToolTip("Playback begins from this second (default 0)")
        row.addWidget(self.spin_start)

        _vline(row)

        self.btn_start = QPushButton("▶  Start Streaming")
        self.btn_start.setObjectName("btn_start")
        self.btn_start.setFixedHeight(36)
        self.btn_start.setMinimumWidth(150)
        self.btn_start.setEnabled(False)
        self.btn_start.clicked.connect(self._on_start)
        row.addWidget(self.btn_start)

        self.btn_pause = QPushButton("⏸  Pause")
        self.btn_pause.setObjectName("btn_pause")
        self.btn_pause.setFixedHeight(36)
        self.btn_pause.setMinimumWidth(110)
        self.btn_pause.setEnabled(False)
        self.btn_pause.clicked.connect(self._on_pause_resume)
        row.addWidget(self.btn_pause)

        self.btn_stop = QPushButton("■  Stop")
        self.btn_stop.setObjectName("btn_stop")
        self.btn_stop.setFixedHeight(36)
        self.btn_stop.setMinimumWidth(100)
        self.btn_stop.setEnabled(False)
        self.btn_stop.clicked.connect(self._on_stop)
        row.addWidget(self.btn_stop)

        _vline(row)

        self.btn_preview = QPushButton("👁  PC Preview: ON")
        self.btn_preview.setObjectName("btn_preview_on")
        self.btn_preview.setFixedHeight(36)
        self.btn_preview.setMinimumWidth(150)
        self.btn_preview.setCheckable(True)
        self.btn_preview.setChecked(True)
        self.btn_preview.setToolTip(
            "Toggle real-time graph on this PC.\n"
            "Disabling saves CPU without affecting the phone stream."
        )
        self.btn_preview.clicked.connect(self._on_toggle_preview)
        row.addWidget(self.btn_preview)

        _vline(row)

        self.lbl_file    = QLabel("File:  No file loaded")
        self.lbl_clients = QLabel("Clients:  0")
        self.lbl_file.setFont(QFont("Consolas", 9))
        self.lbl_clients.setFont(QFont("Consolas", 9))
        row.addWidget(self.lbl_file)
        row.addWidget(self.lbl_clients)
        row.addStretch()

        return box

    def _build_plot_area(self) -> QWidget:
        wrapper = QWidget()
        layout  = QVBoxLayout(wrapper)
        layout.setContentsMargins(0, 0, 0, 0)

        self.plot_widget = pg.PlotWidget(background=BG_DARK)
        self.plot_widget.setLabel("left",   "Amplitude (µV + offset per channel)")
        self.plot_widget.setLabel("bottom", "5-second sliding window")
        self.plot_widget.showGrid(x=True, y=False, alpha=0.15)
        self.plot_widget.setMouseEnabled(x=False, y=False)

        self.x_vals = np.linspace(0, DISPLAY_SECS, BUFFER_SAMPLES)
        self.plot_widget.setXRange(0, DISPLAY_SECS, padding=0)

        self.time_text = pg.TextItem(
            text="00:00 / 00:00",
            color="#FFFFFF",
            anchor=(0, 1),
        )
        self.time_text.setFont(QFont("Consolas", 11))

        layout.addWidget(self.plot_widget)
        return wrapper

    def _build_right_panel(self) -> QWidget:
        wrapper = QWidget()
        wrapper.setMaximumWidth(295)
        layout  = QVBoxLayout(wrapper)
        layout.setContentsMargins(4, 0, 4, 0)
        layout.setSpacing(6)

        qr_box = QGroupBox("📱  Scan QR to Connect  (server always on)")
        qr_lay = QVBoxLayout(qr_box)
        self.lbl_qr = QLabel("Starting server…")
        self.lbl_qr.setAlignment(Qt.AlignCenter)
        self.lbl_qr.setFixedHeight(190)
        self.lbl_url = QLabel("")
        self.lbl_url.setAlignment(Qt.AlignCenter)
        self.lbl_url.setFont(QFont("Consolas", 8))
        self.lbl_url.setWordWrap(True)
        qr_lay.addWidget(self.lbl_qr)
        qr_lay.addWidget(self.lbl_url)
        layout.addWidget(qr_box)

        ch_box = QGroupBox("Channels  —  right-click → change color")
        ch_lay = QVBoxLayout(ch_box)

        btn_row = QHBoxLayout()
        self.btn_all   = QPushButton("All")
        self.btn_clear = QPushButton("Clear")
        self.btn_all.setFixedHeight(24)
        self.btn_clear.setFixedHeight(24)
        self.btn_all.setEnabled(False)
        self.btn_clear.setEnabled(False)
        self.btn_all.clicked.connect(self._on_select_all)
        self.btn_clear.clicked.connect(self._on_clear_all)
        btn_row.addWidget(self.btn_all)
        btn_row.addWidget(self.btn_clear)
        btn_row.addStretch()
        ch_lay.addLayout(btn_row)

        preset_row = QHBoxLayout()
        self.btn_preset_18 = QPushButton("18-CH Preset")
        self.btn_preset_9  = QPushButton("9-CH Preset")
        self.btn_preset_18.setObjectName("btn_preset")
        self.btn_preset_9.setObjectName("btn_preset")
        self.btn_preset_18.setFixedHeight(24)
        self.btn_preset_9.setFixedHeight(24)
        self.btn_preset_18.setEnabled(False)
        self.btn_preset_9.setEnabled(False)
        self.btn_preset_18.setToolTip(
            "Select the standard 18-channel bipolar montage\n"
            "(same channels the AI model expects)"
        )
        self.btn_preset_9.setToolTip("Select the 9-channel lite montage")
        self.btn_preset_18.clicked.connect(lambda: self._on_apply_preset(CHANNELS_18, "18-CH"))
        self.btn_preset_9.clicked.connect(lambda: self._on_apply_preset(CHANNELS_9,  "9-CH"))
        preset_row.addWidget(self.btn_preset_18)
        preset_row.addWidget(self.btn_preset_9)
        ch_lay.addLayout(preset_row)

        self.ch_list = QListWidget()
        self.ch_list.setMinimumHeight(140)
        self.ch_list.itemChanged.connect(self._on_channel_toggle)
        self.ch_list.setContextMenuPolicy(Qt.CustomContextMenu)
        self.ch_list.customContextMenuRequested.connect(self._on_ch_context_menu)
        ch_lay.addWidget(self.ch_list)
        layout.addWidget(ch_box)

        log_box = QGroupBox("Server Log")
        log_lay = QVBoxLayout(log_box)
        self.log_text = QTextEdit()
        self.log_text.setReadOnly(True)
        self.log_text.setFont(QFont("Consolas", 8))
        self.log_text.setMinimumHeight(80)
        log_lay.addWidget(self.log_text)
        layout.addWidget(log_box)
        layout.addStretch()

        return wrapper

    def _build_seek_bar(self) -> QGroupBox:
        box = QGroupBox("Seek  (drag slider  or  use ±10 s buttons)")
        box.setMaximumHeight(62)
        row = QHBoxLayout(box)
        row.setSpacing(6)

        self.btn_back = QPushButton("⟨⟨ 10s")
        self.btn_back.setFixedWidth(70)
        self.btn_back.setFixedHeight(30)
        self.btn_back.setEnabled(False)
        self.btn_back.clicked.connect(lambda: self._skip(-10))
        row.addWidget(self.btn_back)

        self.lbl_cur_time   = QLabel("00:00")
        self.lbl_total_time = QLabel("00:00")
        self.lbl_cur_time.setFont(QFont("Consolas", 10))
        self.lbl_total_time.setFont(QFont("Consolas", 10))
        self.lbl_cur_time.setFixedWidth(50)
        self.lbl_total_time.setFixedWidth(50)

        self.seek_slider = QSlider(Qt.Horizontal)
        self.seek_slider.setRange(0, 10000)
        self.seek_slider.setValue(0)
        self.seek_slider.setEnabled(False)
        self.seek_slider.sliderPressed.connect(
            lambda: setattr(self, "_slider_dragging", True)
        )
        self.seek_slider.sliderReleased.connect(self._on_seek_released)

        row.addWidget(self.lbl_cur_time)
        row.addWidget(self.seek_slider)
        row.addWidget(self.lbl_total_time)

        self.btn_fwd = QPushButton("10s ⟩⟩")
        self.btn_fwd.setFixedWidth(70)
        self.btn_fwd.setFixedHeight(30)
        self.btn_fwd.setEnabled(False)
        self.btn_fwd.clicked.connect(lambda: self._skip(+10))
        row.addWidget(self.btn_fwd)

        return box

    @pyqtSlot()
    def _on_load(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "Open EDF File", "",
            "EDF files (*.edf *.EDF);;All files (*)",
        )
        if not path:
            return

        ok, msg = self.data_handler.load_edf(path)
        if not ok:
            self.lbl_file.setText(f"Error: {msg}")
            self._append_log(f"✗ {msg}")
            return

        fname = path.replace("\\", "/").split("/")[-1]
        self.lbl_file.setText(f"File:  {fname}")
        self.lbl_total_time.setText(fmt_time(self.data_handler.duration))

        self.spin_start.setRange(0, max(0, self.data_handler.duration - 1))
        self.spin_start.setValue(0)
        self.spin_start.setEnabled(True)

        self._populate_channel_list()

        self.seek_slider.setEnabled(True)
        self.btn_start.setEnabled(True)
        self.btn_all.setEnabled(True)
        self.btn_clear.setEnabled(True)
        self.btn_preset_18.setEnabled(True)
        self.btn_preset_9.setEnabled(True)

        self._append_log(f"✓ {msg}")
        self._append_log(f"  Channels: {self.data_handler.channel_names}")

        if self.ws_server.client_count > 0:
            asyncio.ensure_future(self.ws_server.broadcast_config())
            self._append_log(f"  Config re-sent to {self.ws_server.client_count} connected client(s)")

    @pyqtSlot()
    def _on_start(self) -> None:
        if self.streaming:
            return

        self.streaming = True
        self.btn_start.setEnabled(False)
        self.btn_start.setText("Streaming…")
        self.btn_pause.setEnabled(True)
        self.btn_stop.setEnabled(True)
        self.btn_back.setEnabled(True)
        self.btn_fwd.setEnabled(True)

        start_sec = self.spin_start.value()
        self.engine.sequence_id = 0
        self.engine.seek(start_sec)
        self.engine.resume()
        asyncio.ensure_future(self.ws_server.broadcast_status(False))

        self._ui_timer.start()
        self._append_log(f"▶ Streaming started from {fmt_time(start_sec)}")

    @pyqtSlot()
    def _on_pause_resume(self) -> None:
        if self.engine.is_paused:
            self.engine.resume()
            self.btn_pause.setText("⏸  Pause")
            asyncio.ensure_future(self.ws_server.broadcast_status(False))
            self._append_log("▶ Resumed")
        else:
            self.engine.pause()
            self.btn_pause.setText("▶  Resume")
            asyncio.ensure_future(self.ws_server.broadcast_status(True))
            self._append_log("⏸ Paused")

    @pyqtSlot()
    def _on_stop(self) -> None:
        self.engine.pause()
        self.streaming = False
        self._ui_timer.stop()
        asyncio.ensure_future(self.ws_server.broadcast_status(True))

        self.btn_start.setEnabled(True)
        self.btn_start.setText("▶  Start Streaming")
        self.btn_pause.setEnabled(False)
        self.btn_pause.setText("⏸  Pause")
        self.btn_stop.setEnabled(False)
        self.btn_back.setEnabled(False)
        self.btn_fwd.setEnabled(False)
        self._append_log("■ Stopped  (server still running — phone stays connected)")

    @pyqtSlot()
    def _on_seek_released(self) -> None:
        self._slider_dragging = False
        if self.data_handler.is_loaded:
            frac   = self.seek_slider.value() / 10000.0
            second = frac * self.data_handler.duration
            self.engine.seek(second)

    def _skip(self, delta_s: float) -> None:
        if not self.data_handler.is_loaded:
            return
        new_t = max(0.0, min(self.data_handler.duration, self.engine.current_time + delta_s))
        self.engine.seek(new_t)

    def _on_channel_toggle(self, _item: QListWidgetItem) -> None:
        selected = [
            self.ch_list.item(i).text()
            for i in range(self.ch_list.count())
            if self.ch_list.item(i).checkState() == Qt.Checked
        ]
        self.selected_chs = selected
        self.engine.set_pc_channels(selected)
        self._rebuild_plot_curves()
        if self.ws_server.client_count > 0:
            asyncio.ensure_future(self.ws_server.broadcast_config())

    def _on_select_all(self) -> None:
        self.ch_list.blockSignals(True)
        for i in range(self.ch_list.count()):
            self.ch_list.item(i).setCheckState(Qt.Checked)
        self.ch_list.blockSignals(False)
        self._on_channel_toggle(None)

    def _on_clear_all(self) -> None:
        self.ch_list.blockSignals(True)
        for i in range(self.ch_list.count()):
            self.ch_list.item(i).setCheckState(Qt.Unchecked)
        self.ch_list.blockSignals(False)
        self._on_channel_toggle(None)

    def _on_apply_preset(self, preset: List[str], label: str) -> None:
        if not self.data_handler.is_loaded:
            return

        edf_names    = self.data_handler.channel_names
        upper_to_edf = {n.upper(): n for n in edf_names}

        matched  : List[str] = []
        missing  : List[str] = []

        for wanted in preset:
            real = upper_to_edf.get(wanted.upper())
            if real:
                matched.append(real)
            else:
                missing.append(wanted)

        self.ch_list.blockSignals(True)
        matched_set = set(matched)
        for i in range(self.ch_list.count()):
            it = self.ch_list.item(i)
            it.setCheckState(Qt.Checked if it.text() in matched_set else Qt.Unchecked)
        self.ch_list.blockSignals(False)

        self.selected_chs = matched
        self.engine.set_pc_channels(matched)
        self._rebuild_plot_curves()

        if self.ws_server.client_count > 0:
            asyncio.ensure_future(self.ws_server.broadcast_config())

        self._append_log(
            f"✓ {label} preset applied — {len(matched)} channel(s) selected"
        )
        if missing:
            self._append_log(
                f"  ⚠ Missing from EDF ({len(missing)}): {', '.join(missing)}"
            )

    def _on_ch_context_menu(self, pos) -> None:
        item = self.ch_list.itemAt(pos)
        if not item:
            return
        menu = QMenu(self)
        action_color = menu.addAction("🎨  Change Color…")
        result = menu.exec_(self.ch_list.mapToGlobal(pos))
        if result == action_color:
            current_hex = self.channel_colors.get(item.text(), "#FFFFFF")
            color = QColorDialog.getColor(QColor(current_hex), self, "Pick Channel Color")
            if color.isValid():
                self.channel_colors[item.text()] = color.name()
                item.setForeground(color)
                self._rebuild_plot_curves()

    def _on_toggle_preview(self) -> None:
        self._pc_preview_enabled = self.btn_preview.isChecked()
        if self._pc_preview_enabled:
            self.btn_preview.setText("👁  PC Preview: ON")
            self.btn_preview.setObjectName("btn_preview_on")
        else:
            self.btn_preview.setText("🚫  PC Preview: OFF")
            self.btn_preview.setObjectName("btn_preview_off")
            for curve in self.pc_curves:
                curve.setData([], [])
        self.btn_preview.style().unpolish(self.btn_preview)
        self.btn_preview.style().polish(self.btn_preview)
        self._append_log(
            f"{'▶' if self._pc_preview_enabled else '⏹'} PC Preview {'enabled' if self._pc_preview_enabled else 'disabled'} "
            f"(phone stream unaffected)"
        )

    def _on_phone_command(self, cmd: str, data: dict) -> None:
        QTimer.singleShot(0, lambda c=cmd, d=data: self._apply_phone_command(c, d))

    def _apply_phone_command(self, cmd: str, data: dict) -> None:
        if cmd == "PAUSE":
            self.btn_pause.setText("▶  Resume")
        elif cmd == "RESUME":
            self.btn_pause.setText("⏸  Pause")
        elif cmd == "SELECT":
            self._sync_channels_from_phone(data.get("channels", []))

    def _sync_channels_from_phone(self, channels: list) -> None:
        self.engine.set_phone_channels(channels)
        self._append_log(f"Phone filter → {channels}")

    def _refresh_ui(self) -> None:
        if not self.data_handler.is_loaded:
            return

        pos      = self.engine.position
        cur_time = self.engine.current_time
        dur      = self.data_handler.duration

        self.lbl_cur_time.setText(fmt_time(cur_time))
        self.time_text.setText(f"  ⏱ {fmt_time(cur_time)} / {fmt_time(dur)}")

        if not self._slider_dragging and dur > 0:
            self.seek_slider.setValue(int((cur_time / dur) * 10000))

        self.lbl_clients.setText(f"Clients:  {self.ws_server.client_count}")

        if not self._pc_preview_enabled:
            return

        if not self.selected_chs or not self.pc_curves:
            return

        window = self.data_handler.get_display_window(pos, self.selected_chs)
        n = len(self.selected_chs)
        for i, ch in enumerate(self.selected_chs[:len(self.pc_curves)]):
            if ch in window:
                y = window[ch] + (n - 1 - i) * CHANNEL_OFFSET
                self.pc_curves[i].setData(self.x_vals[:len(y)], y)

    def _rebuild_plot_curves(self) -> None:
        self.plot_widget.clear()
        self.pc_curves     = []
        self.ch_text_items = []

        n = len(self.selected_chs)

        if n == 0:
            self.plot_widget.addItem(self.time_text)
            self.time_text.setPos(0, 10)
            return

        y_min = -CHANNEL_OFFSET * 0.6
        y_max = (n - 1) * CHANNEL_OFFSET + CHANNEL_OFFSET * 0.6
        self.plot_widget.setYRange(y_min, y_max + 30, padding=0)

        for i, ch in enumerate(self.selected_chs):
            full_idx      = self.data_handler.channel_names.index(ch) \
                            if ch in self.data_handler.channel_names else i
            default_color = CHANNEL_COLORS[full_idx % len(CHANNEL_COLORS)]
            color = self.channel_colors.setdefault(ch, default_color)

            pen   = pg.mkPen(color=color, width=1.4)
            curve = self.plot_widget.plot(pen=pen, name=ch)
            self.pc_curves.append(curve)

            y_center = (n - 1 - i) * CHANNEL_OFFSET
            label = pg.TextItem(text=ch, color=color, anchor=(0, 0.5))
            label.setFont(QFont("Consolas", 9))
            label.setPos(0.05, y_center)
            self.plot_widget.addItem(label)
            self.ch_text_items.append(label)

        self.plot_widget.addItem(self.time_text)
        self.time_text.setPos(0.05, y_max + 15)

        self.ch_list.blockSignals(True)
        for i in range(self.ch_list.count()):
            it = self.ch_list.item(i)
            ch = it.text()
            if ch in self.channel_colors:
                it.setForeground(QColor(self.channel_colors[ch]))
        self.ch_list.blockSignals(False)

    def _get_default_channels(self) -> List[str]:
        names     = self.data_handler.channel_names
        upper_map = {n.upper(): n for n in names}
        matched   = []
        for wanted in CHANNELS_18:
            real = upper_map.get(wanted.upper())
            if real and real not in matched:
                matched.append(real)

        if matched:
            return matched[:MAX_DISPLAY_CH]

        return names[:min(18, len(names))]

    def _populate_channel_list(self) -> None:
        default_sel = self._get_default_channels()

        self.ch_list.blockSignals(True)
        self.ch_list.clear()

        for i, ch in enumerate(self.data_handler.channel_names):
            item = QListWidgetItem(ch)
            item.setCheckState(
                Qt.Checked if ch in default_sel else Qt.Unchecked
            )
            color = self.channel_colors.setdefault(
                ch, CHANNEL_COLORS[i % len(CHANNEL_COLORS)]
            )
            item.setForeground(QColor(color))
            self.ch_list.addItem(item)

        self.ch_list.blockSignals(False)

        self.selected_chs = list(default_sel)
        self.engine.set_channels(self.selected_chs)
        self._rebuild_plot_curves()

    def _show_qr(self, url: str) -> None:
        pixmap = make_qr_pixmap(url)
        if pixmap:
            self.lbl_qr.setPixmap(pixmap)
        else:
            self.lbl_qr.setText(
                "pip install qrcode[pil]\nto enable QR code\n\n" + url
            )
        self.lbl_url.setText(url)

    def _on_ws_status(self, message: str) -> None:
        QTimer.singleShot(0, lambda msg=message: self._append_log(msg))

    def _append_log(self, message: str) -> None:
        self.log_text.append(message)
        sb = self.log_text.verticalScrollBar()
        sb.setValue(sb.maximum())

    def closeEvent(self, event):
        self._ui_timer.stop()
        asyncio.ensure_future(self.ws_server.stop())
        event.accept()

    def _apply_theme(self) -> None:
        self.setStyleSheet(f"""
            QMainWindow, QWidget {{
                background: {BG_DARK};
                color: #CCDDEE;
            }}
            QGroupBox {{
                background: {BG_PANEL};
                border: 1px solid #1A2040;
                border-radius: 6px;
                margin-top: 6px;
                padding: 4px 6px;
                font-weight: bold;
                color: #8899BB;
                font-size: 10px;
            }}
            QGroupBox::title {{
                subcontrol-origin: margin;
                left: 10px;
                padding: 0 4px;
            }}
            QPushButton {{
                background: #161630;
                border: 1px solid #2A3060;
                border-radius: 5px;
                color: #CCDDEE;
                padding: 4px 14px;
                font-size: 11px;
            }}
            QPushButton:hover    {{ background: #202050; border-color: #5566AA; }}
            QPushButton:disabled {{ background: #0D0D1A; color: #334455; border-color: #151530; }}
            QPushButton#btn_start       {{ background: #0A2A15; border-color: #1A6635; color: #44FF88; font-weight: bold; }}
            QPushButton#btn_pause       {{ background: #2A2A0A; border-color: #666615; color: #FFFF44; font-weight: bold; }}
            QPushButton#btn_stop        {{ background: #2A0A0A; border-color: #661515; color: #FF4444; font-weight: bold; }}
            QPushButton#btn_preview_on  {{ background: #0A1A2A; border-color: #1A4066; color: #44AAFF; font-weight: bold; }}
            QPushButton#btn_preview_off {{ background: #1A1A0A; border-color: #404015; color: #888844; font-weight: bold; }}
            QPushButton#btn_preset      {{ background: #0D1A0D; border-color: #1A4020; color: #44CC66; font-size: 10px; }}
            QPushButton#btn_preset:hover {{ background: #142A14; border-color: #2A6030; }}
            QPushButton#btn_preset:disabled {{ background: #0A0A10; color: #334433; border-color: #111811; }}
            QDoubleSpinBox {{
                background: #0D0D22;
                border: 1px solid #2A3060;
                border-radius: 4px;
                color: #CCDDEE;
                padding: 2px 6px;
                font-family: Consolas;
                font-size: 10px;
            }}
            QSlider::groove:horizontal {{
                height: 6px;
                background: #1A2040;
                border-radius: 3px;
            }}
            QSlider::handle:horizontal {{
                background: #4488FF;
                border: 1px solid #2255CC;
                width: 14px; height: 14px;
                margin: -4px 0;
                border-radius: 7px;
            }}
            QSlider::sub-page:horizontal {{ background: #2255AA; border-radius: 3px; }}
            QListWidget {{
                background: #0A0A18;
                color: #AABBCC;
                font-size: 10px;
                font-family: Consolas;
            }}
            QListWidget::item:selected {{ background: #1A2A50; }}
            QTextEdit  {{ background: #050510; color: #7788AA; border: 1px solid #1A2040; font-size: 9px; }}
            QLabel     {{ color: #AABBCC; }}
            QFrame[frameShape="5"] {{ color: #1A2040; }}
            QMenu      {{ background: #0D0D22; border: 1px solid #2A3060; color: #CCDDEE; }}
            QMenu::item:selected {{ background: #1A2A50; }}
        """)


def main() -> None:
    pg.setConfigOptions(
        antialias  = True,
        useOpenGL  = False,
        foreground = "#CCDDEE",
        background = BG_DARK,
    )

    app = QApplication(sys.argv)
    app.setApplicationName("EEG Simulator")

    _logo = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'logo.png')
    if os.path.exists(_logo):
        app.setWindowIcon(QIcon(_logo))

    loop = qasync.QEventLoop(app)
    asyncio.set_event_loop(loop)

    window = EEGMainWindow()
    window.show()

    with loop:
        loop.run_forever()


if __name__ == "__main__":
    main()
