export interface SessionConfig {
  channels     : string[];
  duration     : number;
  samplingRate : number;
  totalSamples : number;
}

export interface EEGPacket {
  sequenceId : number;
  time       : number;
  labels     : string[];
  data       : number[][];
  fs         : number;
}

export type ConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error';

export type OnPacketCb       = (packet: EEGPacket)     => void;
export type OnConfigCb       = (config: SessionConfig) => void;
export type OnStatusCb       = (status: ConnectionStatus, msg?: string) => void;
export type OnServerStatusCb = (paused: boolean) => void;


export class EEGWSManager {
  private ws           : WebSocket | null = null;
  private _url         : string           = '';
  private _intentional : boolean          = false;

  public connectedHost : string | null    = null;

  private readonly onPacket       : OnPacketCb;
  private readonly onConfig       : OnConfigCb;
  private readonly onStatus       : OnStatusCb;
  private readonly onServerStatus : OnServerStatusCb;

  constructor(
    onPacket       : OnPacketCb,
    onConfig       : OnConfigCb,
    onStatus       : OnStatusCb,
    onServerStatus : OnServerStatusCb,
  ) {
    this.onPacket       = onPacket;
    this.onConfig       = onConfig;
    this.onStatus       = onStatus;
    this.onServerStatus = onServerStatus;
  }

  connect(urlOrIp: string, port: number = 8765): void {
    const cleaned = urlOrIp.trim();
    if (!cleaned) {
      this.onStatus('error', "Enter the PC's IP address or scan the QR code.");
      return;
    }

    this._url = cleaned.startsWith('ws://') ? cleaned : `ws://${cleaned}:${port}`;
    this._intentional = false;

    this._openSocket();
  }

  disconnect(): void {
    this._intentional = true;
    this._closeSocket();
    this.onStatus('disconnected');
  }

  destroy(): void {
    this._intentional = true;
    this._closeSocket();
  }

  sendSelectChannels(channels: string[]): void {
    this._send({ cmd: 'SELECT', channels });
  }

  private _openSocket(): void {
    this._closeSocket();

    this.onStatus('connecting', `Connecting to ${this._url} …`);

    this.ws = new WebSocket(this._url);

    this.ws.onopen = () => {
      try {
        const match = this._url.match(/^ws:\/\/([^:/]+)/);
        this.connectedHost = match ? match[1] : null;
      } catch { this.connectedHost = null; }
      this.onStatus('connected', `Connected to ${this._url}`);
    };

    this.ws.onmessage = (event: MessageEvent) => {
      this._handleMessage(event.data as string);
    };

    this.ws.onerror = () => {
      this.onStatus(
        'error',
        `Cannot reach ${this._url} — check PC is streaming and both devices are on the same WiFi.`,
      );
    };

    this.ws.onclose = (event: CloseEvent) => {
      this.ws = null;
      if (!this._intentional && event.code !== 1000) {
        this.onStatus('disconnected', 'Connection lost — check PC and WiFi');
      }
    };
  }

  private _closeSocket(): void {
    if (this.ws) {
      this.ws.onopen    = null;
      this.ws.onmessage = null;
      this.ws.onerror   = null;
      this.ws.onclose   = null;
      if (
        this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING
      ) {
        this.ws.close(1000, 'Client disconnected');
      }
      this.ws = null;
    }
  }

  private _handleMessage(raw: string): void {
    try {
      const msg = JSON.parse(raw);

      if (msg.type === 'config') {
        const config: SessionConfig = {
          channels     : msg.channels     ?? [],
          duration     : msg.duration     ?? 0,
          samplingRate : msg.samplingRate  ?? 256,
          totalSamples : msg.totalSamples  ?? 0,
        };
        this.onConfig(config);

      } else if (msg.type === 'data') {
        if (
          typeof msg.seq    !== 'number' ||
          !Array.isArray(msg.labels)     ||
          !Array.isArray(msg.data)
        ) {
          console.warn('[WS] Malformed data packet', msg);
          return;
        }
        const packet: EEGPacket = {
          sequenceId : msg.seq               as number,
          time       : msg.time              as number,
          labels     : msg.labels            as string[],
          data       : msg.data              as number[][],
          fs         : (msg.fs ?? 256)       as number,
        };
        this.onPacket(packet);

      } else if (msg.type === 'status') {
        this.onServerStatus(msg.paused === true);

      } else {
        console.warn('[WS] Unknown message type:', msg.type);
      }

    } catch (err) {
      console.error('[WS] JSON parse error:', err);
    }
  }

  private _send(payload: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }
}
