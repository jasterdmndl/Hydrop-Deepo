/** Server clock port. Tests inject a controllable clock. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** A clock that only moves when told to; for tests. */
export class ManualClock implements Clock {
  private current: number;

  constructor(start: Date | string) {
    this.current = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current += ms;
  }

  set(at: Date | string): void {
    this.current = new Date(at).getTime();
  }
}

export const BUSINESS_TIME_ZONE = "Asia/Manila";
