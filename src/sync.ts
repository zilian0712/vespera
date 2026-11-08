import type { Playback } from './room';

export const TELEMETRY_TTL = 5000;

export function projectPosition(playback: Playback, now: number): number {
  const elapsed = Math.max(0, now - playback.updatedAt) / 1000;
  const position = playback.position + (playback.paused ? 0 : elapsed * playback.rate);
  return Math.max(0, Math.min(604800, position));
}

export function chooseCorrection(
  current: number,
  target: number,
  paused: boolean,
  rate: number,
  force = false,
): { seek: number | null; rate: number } {
  const drift = target - current;
  const distance = Math.abs(drift);
  if (force) return { seek: distance > 0.025 ? target : null, rate };
  if (paused) return { seek: null, rate };
  if (distance > 2) return { seek: target, rate };
  if (distance < 0.08) return { seek: null, rate };
  const adjustment = Math.round(Math.max(-0.05, Math.min(0.05, drift * 0.1)) * 200) / 200;
  return { seek: null, rate: rate * (1 + adjustment) };
}

type ClockSample = { receivedAt: number; rtt: number; offset: number };

export class ServerClock {
  private samples: ClockSample[] = [];
  private offset: number;
  private targetOffset: number;
  private lastLocal: number;
  private calibrated = false;

  constructor(
    private readonly localNow: () => number = () => performance.now(),
    wallNow: () => number = () => Date.now(),
  ) {
    this.lastLocal = localNow();
    this.offset = wallNow() - this.lastLocal;
    this.targetOffset = this.offset;
  }

  get ready(): boolean {
    return this.samples.length >= 3;
  }

  get latency(): number | null {
    return this.samples.length ? Math.min(...this.samples.map(sample => sample.rtt)) : null;
  }

  now(): number {
    const local = Math.max(this.lastLocal, this.localNow());
    const elapsed = local - this.lastLocal;
    const adjustment = this.targetOffset - this.offset;
    // Slew later estimates so a slightly better sample cannot turn time backwards.
    this.offset += Math.max(-elapsed * 0.1, Math.min(elapsed * 0.1, adjustment));
    this.lastLocal = local;
    return local + this.offset;
  }

  sample(sentAt: number, receivedAt: number, serverTime: number): boolean {
    if (![sentAt, receivedAt, serverTime].every(Number.isFinite)
      || sentAt < 0 || receivedAt < sentAt || receivedAt - sentAt > 10000
      || serverTime < 0 || serverTime > Number.MAX_SAFE_INTEGER) return false;

    this.samples = this.samples.filter(sample => receivedAt - sample.receivedAt <= 60000);
    this.samples.push({
      receivedAt,
      rtt: receivedAt - sentAt,
      offset: serverTime - (sentAt + receivedAt) / 2,
    });
    this.samples = this.samples.slice(-8);
    const best = this.samples.reduce((lowest, sample) => sample.rtt <= lowest.rtt ? sample : lowest);
    if (this.calibrated) this.now();
    else this.offset = best.offset;
    this.targetOffset = best.offset;
    this.calibrated ||= this.ready;
    return true;
  }
}
