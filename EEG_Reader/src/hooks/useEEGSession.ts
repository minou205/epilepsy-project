import { useState, useRef, useCallback, useEffect } from 'react';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import {
  EEGWSManager,
  EEGPacket,
  SessionConfig,
  ConnectionStatus,
} from '../services/WSManager';

const BUFFER_SECS      = 5;
const LONG_BUFFER_SECS = 22 * 60;   // 22 minutes for seizure capture
const bufferSize       = (sr: number) => BUFFER_SECS * sr;
const longBufSize      = (sr: number) => LONG_BUFFER_SECS * sr;

// Default preferred channels when auto-selecting on connect
const CHANNELS_9_PREFERRED = [
  'FP1-F7', 'F7-T7',
  'FP2-F8', 'F8-T8',
  'FP1-F3', 'F3-C3',
  'FP2-F4', 'F4-C4',
  'FZ-CZ',
];

function pickDefaultChannels(allChannels: string[]): string[] {
  const upperMap = new Map(allChannels.map(ch => [ch.toUpperCase(), ch]));
  const matched  = CHANNELS_9_PREFERRED
    .map(w => upperMap.get(w.toUpperCase()))
    .filter((ch): ch is string => ch !== undefined);
  return matched.length > 0 ? matched : allChannels.slice(0, 4);
}

export const CHANNEL_COLORS = [
  "#00FF88", "#FF6644", "#4499FF", "#FFCC00",
  "#FF44CC", "#44FFFF", "#AAFF44", "#FF8833",
  "#CC44FF", "#44FFCC",
];

export interface ChannelDisplay {
  name  : string;
  color : string;
  /** Float32Array — native typed array, avoids per-sample boxing. */
  data  : Float32Array;
}

export interface EEGSession {
  status         : ConnectionStatus;
  statusMessage  : string;
  config         : SessionConfig | null;
  currentTime    : number;
  displayData    : ChannelDisplay[];
  /** Channels requested from the PC (sent via SELECT command). */
  selectedChannels  : string[];
  toggleChannel     : (name: string) => void;
  selectAll         : () => void;
  clearAll          : () => void;
  /** Explicitly set the streamed channel list (used to enforce a saved headset). */
  selectChannels    : (names: string[]) => void;
  droppedPackets    : number;
  packetCount       : number;
  isRecording       : boolean;
  recordingPath     : string;
  connect           : (urlOrIp: string) => void;
  disconnect        : () => void;
  startRecording    : () => Promise<void>;
  stopRecording     : () => Promise<void>;
  /** Get last `durationSecs` of raw EEG for a channel from the long-term buffer. */
  getLongBufferSnapshot : (channelName: string, durationSecs: number) => Float32Array | null;
  /** How many seconds of long-term data have accumulated so far. */
  longBufferReadySecs   : number;
  /** Host/IP of the connected EEG simulator (e.g. "172.20.10.3"). */
  connectedHost         : string | null;

  // ── Graph rendering controls (fully independent of data / AI path) ──
  /** When false the chart returns null — saves 100% of GPU resources. */
  graphEnabled       : boolean;
  /** Subset of incoming channels chosen for rendering. */
  graphChannels      : string[];
  setGraphEnabled    : (enabled: boolean) => void;
  toggleGraphChannel : (name: string) => void;
  setAllGraphChannels: () => void;
  clearGraphChannels : () => void;
}

export function useEEGSession(): EEGSession {

  const [status,         setStatus        ] = useState<ConnectionStatus>('disconnected');
  const [statusMessage,  setStatusMessage ] = useState('Scan QR code or enter PC IP');
  const [config,         setConfig        ] = useState<SessionConfig | null>(null);
  const [currentTime,    setCurrentTime   ] = useState(0);

  const [selectedChannels, setSelectedChannels] = useState<string[]>([]);

  const [droppedPackets, setDroppedPackets] = useState(0);
  const [packetCount,    setPacketCount   ] = useState(0);

  const [isRecording,   setIsRecording  ] = useState(false);
  const [recordingPath, setRecordingPath] = useState('');

  const [displayData, setDisplayData] = useState<ChannelDisplay[]>([]);

  // ── Graph rendering state ──
  const [graphEnabled,  setGraphEnabledState] = useState(true);
  const [graphChannels, setGraphChannels    ] = useState<string[]>([]);
  const graphEnabledRef  = useRef(true);
  const graphChannelsRef = useRef<string[]>([]);

  // ── Refs ──
  const wsRef               = useRef<EEGWSManager | null>(null);
  const configRef           = useRef<SessionConfig | null>(null);
  const selectedChannelsRef = useRef<string[]>([]);
  const streamingLabelsRef  = useRef<string[]>([]);  // labels from the last received packet

  // Short display buffers (5-sec rolling): pre-allocated for all config channels (cheap: ~5 KB each)
  const channelBuffers = useRef<Map<string, Float32Array>>(new Map());

  // Long circular buffers (22-min): LAZY-allocated in handlePacket — only for channels
  // that actually arrive, not all EDF channels (saves ~1.3 MB per missing channel).
  const longChannelBuffers = useRef<Map<string, Float32Array>>(new Map());
  const longWritePointers  = useRef<Map<string, number>>(new Map());
  const longSamplesWritten = useRef<Map<string, number>>(new Map());

  const prevSeqRef       = useRef(-1);
  const totalDropRef     = useRef(0);
  const totalPktsRef     = useRef(0);
  const csvRowsRef       = useRef<string[]>([]);
  const recordPathRef    = useRef('');
  const isRecordingRef   = useRef(false);
  const rafRef           = useRef<number | null>(null);

  const [longBufferReadySecs, setLongBufferReadySecs] = useState(0);
  const longReadyUpdateRef = useRef(0);
  const [connectedHost, setConnectedHost] = useState<string | null>(null);

  useEffect(() => { selectedChannelsRef.current = selectedChannels; }, [selectedChannels]);
  useEffect(() => { isRecordingRef.current = isRecording; }, [isRecording]);

  // ── Config handler ─────────────────────────────────────────────────────────

  const handleConfig = useCallback((cfg: SessionConfig) => {
    const prevCfg = configRef.current;

    // Identical layout? The simulator re-sent config after reconnect — preserve long buffers.
    const sameLayout =
      prevCfg !== null &&
      prevCfg.samplingRate === cfg.samplingRate &&
      prevCfg.channels.length === cfg.channels.length &&
      prevCfg.channels.every((ch, i) => ch === cfg.channels[i]);

    configRef.current = cfg;
    setConfig(cfg);

    const sr   = cfg.samplingRate || 256;
    const size = bufferSize(sr);

    // Always rebuild short display buffers — cheap (N × ~5 KB).
    const newDisplayMap = new Map<string, Float32Array>();
    for (const ch of cfg.channels) {
      newDisplayMap.set(ch, new Float32Array(size));
    }
    channelBuffers.current = newDisplayMap;

    if (!sameLayout) {
      // New EDF / different channel set — clear everything.
      // Long buffers are NOT pre-allocated here; handlePacket allocates them
      // lazily only for channels that actually carry data.
      longChannelBuffers.current.clear();
      longWritePointers.current.clear();
      longSamplesWritten.current.clear();
      streamingLabelsRef.current = [];
      setLongBufferReadySecs(0);
      longReadyUpdateRef.current = 0;

      const defaultSel = pickDefaultChannels(cfg.channels);
      setSelectedChannels(defaultSel);
      selectedChannelsRef.current = defaultSel;
      wsRef.current?.sendSelectChannels(defaultSel);

      // Default: render first 4 selected channels to keep GPU load low
      const defaultGraph = defaultSel.slice(0, 4);
      setGraphChannels(defaultGraph);
      graphChannelsRef.current = defaultGraph;

      prevSeqRef.current   = -1;
      totalDropRef.current = 0;
      totalPktsRef.current = 0;
      setDroppedPackets(0);
      setPacketCount(0);
      setCurrentTime(0);
    }
  }, []);

  // ── Packet handler ─────────────────────────────────────────────────────────

  const handlePacket = useCallback((packet: EEGPacket) => {

    // Sequence gap detection
    if (prevSeqRef.current >= 0) {
      const gap = packet.sequenceId - prevSeqRef.current - 1;
      if (gap > 0) {
        totalDropRef.current += gap;
        setDroppedPackets(totalDropRef.current);
      }
    }
    prevSeqRef.current = packet.sequenceId;
    totalPktsRef.current += 1;
    setCurrentTime(packet.time);

    streamingLabelsRef.current = packet.labels;

    const sr      = configRef.current?.samplingRate ?? packet.fs ?? 256;
    const bufSize = bufferSize(sr);
    const lbSize  = longBufSize(sr);

    for (let ci = 0; ci < packet.labels.length; ci++) {
      const chName  = packet.labels[ci];
      const samples = packet.data[ci];
      if (!samples) continue;
      const n = samples.length;

      // ── Short display buffer (5-sec rolling) ──
      const buf = channelBuffers.current.get(chName);
      if (buf) {
        buf.copyWithin(0, n);                            // shift left by n
        for (let i = 0; i < n; i++) {
          buf[bufSize - n + i] = samples[i];             // append at tail
        }
      }

      // ── Long circular buffer (22-min) — lazy allocation ──
      if (!longChannelBuffers.current.has(chName)) {
        longChannelBuffers.current.set(chName, new Float32Array(lbSize));
        longWritePointers.current.set(chName, 0);
        longSamplesWritten.current.set(chName, 0);
      }
      const lbuf = longChannelBuffers.current.get(chName)!;
      let   ptr  = longWritePointers.current.get(chName)!;
      let   cnt  = longSamplesWritten.current.get(chName)!;
      for (let i = 0; i < n; i++) {
        lbuf[ptr] = samples[i];
        ptr = (ptr + 1) % lbSize;
        cnt++;
      }
      longWritePointers.current.set(chName, ptr);
      longSamplesWritten.current.set(chName, cnt);
    }

    // Update ready-seconds indicator (~once per second) using first streaming channel
    const firstCh = packet.labels[0];
    if (firstCh) {
      const cnt  = longSamplesWritten.current.get(firstCh) ?? 0;
      const secs = Math.min(Math.floor(cnt / sr), LONG_BUFFER_SECS);
      if (secs !== longReadyUpdateRef.current) {
        longReadyUpdateRef.current = secs;
        setLongBufferReadySecs(secs);
      }
    }

    // CSV recording
    if (isRecordingRef.current) {
      const ts = Date.now();
      for (let ci = 0; ci < packet.labels.length; ci++) {
        const chName  = packet.labels[ci];
        const samples = packet.data[ci];
        if (!samples) continue;
        for (let i = 0; i < samples.length; i++) {
          const t   = (ts + (i * 1000) / sr).toFixed(2);
          const idx = packet.sequenceId * samples.length + i;
          csvRowsRef.current.push(`${t},${chName},${idx},${samples[i].toFixed(4)}`);
        }
      }
    }

    // ── Animation-frame update (chart display only) ──
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);

    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      setPacketCount(totalPktsRef.current);

      // High-Performance Mode: skip all display-data work
      if (!graphEnabledRef.current) return;

      // Render graphChannels, or fall back to all streaming labels
      const toRender = graphChannelsRef.current.length > 0
        ? graphChannelsRef.current
        : streamingLabelsRef.current;

      const allChs    = configRef.current?.channels ?? [];
      const snapshot  : ChannelDisplay[] = [];

      for (const ch of toRender) {
        const buf = channelBuffers.current.get(ch);
        if (buf) {
          const colorIdx = allChs.indexOf(ch);
          snapshot.push({
            name  : ch,
            color : CHANNEL_COLORS[(colorIdx >= 0 ? colorIdx : 0) % CHANNEL_COLORS.length],
            data  : buf.slice(),   // typed-array copy — no per-sample boxing
          });
        }
      }
      setDisplayData(snapshot);
    });

  }, []);

  // ── Status handlers ────────────────────────────────────────────────────────

  const handleStatus = useCallback((s: ConnectionStatus, msg?: string) => {
    setStatus(s);
    setStatusMessage(msg ?? s);
    // Capture host IP when connected (for backend URL auto-detection)
    if (s === 'connected' && wsRef.current?.connectedHost) {
      setConnectedHost(wsRef.current.connectedHost);
    } else if (s === 'disconnected') {
      setConnectedHost(null);
    }
  }, []);

  const handleServerStatus = useCallback((_paused: boolean) => {
    // Server status received but playback controls removed from phone
  }, []);

  useEffect(() => {
    wsRef.current = new EEGWSManager(handlePacket, handleConfig, handleStatus, handleServerStatus);
    return () => {
      wsRef.current?.destroy();
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [handlePacket, handleConfig, handleStatus, handleServerStatus]);

  // ── Graph rendering controls ───────────────────────────────────────────────

  const setGraphEnabled = useCallback((enabled: boolean) => {
    graphEnabledRef.current = enabled;
    setGraphEnabledState(enabled);
    if (!enabled) setDisplayData([]);
  }, []);

  const toggleGraphChannel = useCallback((name: string) => {
    setGraphChannels(prev => {
      const next = prev.includes(name)
        ? prev.filter(c => c !== name)
        : [...prev, name];
      graphChannelsRef.current = next;
      return next;
    });
  }, []);

  const setAllGraphChannels = useCallback(() => {
    // "All" = all channels currently streaming
    const all = streamingLabelsRef.current.length > 0
      ? streamingLabelsRef.current
      : selectedChannelsRef.current;
    setGraphChannels(all);
    graphChannelsRef.current = all;
  }, []);

  const clearGraphChannels = useCallback(() => {
    setGraphChannels([]);
    graphChannelsRef.current = [];
  }, []);

  // ── Stream channel controls (SELECT command to PC) ────────────────────────

  const toggleChannel = useCallback((name: string) => {
    setSelectedChannels(prev => {
      const next = prev.includes(name)
        ? prev.filter(c => c !== name)
        : [...prev, name];
      selectedChannelsRef.current = next;
      wsRef.current?.sendSelectChannels(next);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    const all = configRef.current?.channels ?? [];
    setSelectedChannels(all);
    selectedChannelsRef.current = all;
    wsRef.current?.sendSelectChannels(all);
  }, []);

  const clearAll = useCallback(() => {
    setSelectedChannels([]);
    selectedChannelsRef.current = [];
    wsRef.current?.sendSelectChannels([]);
  }, []);

  const selectChannels = useCallback((names: string[]) => {
    // Used to enforce a saved headset's locked channel set.
    setSelectedChannels(names);
    selectedChannelsRef.current = names;
    wsRef.current?.sendSelectChannels(names);
  }, []);

  // ── Connection controls ────────────────────────────────────────────────────

  const connect = useCallback((urlOrIp: string) => {
    setConfig(null);
    setSelectedChannels([]);
    setCurrentTime(0);
    setDroppedPackets(0);
    setPacketCount(0);
    setDisplayData([]);
    channelBuffers.current.clear();
    longChannelBuffers.current.clear();
    longWritePointers.current.clear();
    longSamplesWritten.current.clear();
    streamingLabelsRef.current = [];
    prevSeqRef.current   = -1;
    totalDropRef.current = 0;
    totalPktsRef.current = 0;
    wsRef.current?.connect(urlOrIp);
  }, []);

  const disconnect = useCallback(() => {
    wsRef.current?.disconnect();
  }, []);

  // ── Long-buffer snapshot (used by inference / seizure data collector) ──────

  /**
   * Returns up to the last `durationSecs` of raw EEG for `channelName`.
   * Returns null only when no data has been recorded for that channel yet.
   */
  const getLongBufferSnapshot = useCallback(
    (channelName: string, durationSecs: number): Float32Array | null => {
      const lbuf = longChannelBuffers.current.get(channelName);
      if (!lbuf) return null;

      const sr      = configRef.current?.samplingRate ?? 256;
      const lbSize  = lbuf.length;
      const written = longSamplesWritten.current.get(channelName) ?? 0;

      if (written === 0) return null;

      const wanted    = Math.round(durationSecs * sr);
      const available = Math.min(written, lbSize);
      const actual    = Math.min(wanted, available);

      const ptr = longWritePointers.current.get(channelName) ?? 0;
      const out = new Float32Array(actual);

      if (written < lbSize) {
        out.set(lbuf.subarray(written - actual, written));
      } else {
        let readPos = (ptr - 1 + lbSize) % lbSize;
        for (let i = actual - 1; i >= 0; i--) {
          out[i]  = lbuf[readPos];
          readPos = (readPos - 1 + lbSize) % lbSize;
        }
      }
      return out;
    },
    [],
  );

  // ── CSV recording ──────────────────────────────────────────────────────────

  const startRecording = useCallback(async () => {
    if (isRecording) return;
    const ts   = new Date().toISOString().replace(/[:.]/g, '-');
    const path = `${FileSystem.documentDirectory}EEG_${ts}.csv`;
    try {
      await FileSystem.writeAsStringAsync(
        path,
        'timestamp_ms,channel,sample_index,amplitude_uV\n',
        { encoding: FileSystem.EncodingType.UTF8 },
      );
      recordPathRef.current = path;
      csvRowsRef.current    = [];
      setRecordingPath(path);
      setIsRecording(true);
    } catch (err) {
      console.error('[Record] Failed:', err);
    }
  }, [isRecording]);

  const stopRecording = useCallback(async () => {
    if (!isRecording) return;
    setIsRecording(false);
    const path = recordPathRef.current;
    try {
      const header   = await FileSystem.readAsStringAsync(path);
      const dataRows = csvRowsRef.current.join('\n');
      await FileSystem.writeAsStringAsync(
        path,
        header + dataRows + '\n',
        { encoding: FileSystem.EncodingType.UTF8 },
      );
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(path, {
          mimeType   : 'text/csv',
          dialogTitle: 'Save EEG Recording',
          UTI        : 'public.comma-separated-values-text',
        });
      }
    } catch (err) {
      console.error('[Record] Failed to write CSV:', err);
    }
    csvRowsRef.current = [];
  }, [isRecording]);

  return {
    status, statusMessage,
    config, currentTime,
    displayData,
    selectedChannels, toggleChannel, selectAll, clearAll, selectChannels,
    droppedPackets, packetCount,
    isRecording, recordingPath,
    connect, disconnect,
    startRecording, stopRecording,
    getLongBufferSnapshot,
    longBufferReadySecs,
    connectedHost,
    graphEnabled, graphChannels,
    setGraphEnabled, toggleGraphChannel, setAllGraphChannels, clearGraphChannels,
  };
}
