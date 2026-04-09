import { EEGSession } from '../hooks/useEEGSession';

/**
 * Checks every 500ms whether the EEG signal has been lost (all zeros).
 * Calls `onLost(true)` when signal is absent for > thresholdMs,
 * and `onLost(false)` when signal recovers.
 */
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

    // Check the first channel's latest 16 samples for all-zero
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
        this.onLost(false); // signal recovered
      }
    } else if (!this.isLost && (now - this.lastNonZeroAt) > this.thresholdMs) {
      this.isLost = true;
      this.onLost(true); // signal lost
    }
  }

  destroy(): void {
    if (this.checkInterval !== null) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }
}
