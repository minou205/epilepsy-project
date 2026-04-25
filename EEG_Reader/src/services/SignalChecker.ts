import { EEGSession } from '../hooks/useEEGSession';

export class SignalChecker {
  private checkInterval : ReturnType<typeof setInterval> | null = null;
  private lastNonZeroAt : number = Date.now();
  private isLost        : boolean = false;

  constructor(
    private readonly eegSession : EEGSession,
    private readonly onLost     : (lost: boolean) => void,
    private readonly thresholdMs: number = 3000,
  ) {
    this.checkInterval = setInterval(() => this.check(), 500);
  }

  private check(): void {
    const { displayData } = this.eegSession;
    if (displayData.length === 0) return;

    const samples = displayData[0].data;
    const len     = samples.length;
    const tail    = Math.min(16, len);
    let   allZero = true;

    for (let i = len - tail; i < len; i++) {
      if (samples[i] !== 0) {
        allZero = false;
        break;
      }
    }

    const now = Date.now();

    if (!allZero) {
      this.lastNonZeroAt = now;
      if (this.isLost) {
        this.isLost = false;
        this.onLost(false);
      }
    } else if (!this.isLost && (now - this.lastNonZeroAt) > this.thresholdMs) {
      this.isLost = true;
      this.onLost(true);
    }
  }

  destroy(): void {
    if (this.checkInterval !== null) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }
}
