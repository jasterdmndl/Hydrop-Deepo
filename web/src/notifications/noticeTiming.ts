export const NOTICE_DURATION_MS = {
  brief: 8_000,
  detailed: 15_000,
} as const;

export type NoticeDuration = keyof typeof NOTICE_DURATION_MS;

export interface NoticeEnvelope<T> {
  id: number;
  data: T;
}

let nextOccurrenceSequence = 1;

export function nextNoticeId(): number {
  const id = nextOccurrenceSequence;
  nextOccurrenceSequence += 1;
  return id;
}

export function wrapNotice<T>(data: T): NoticeEnvelope<T> {
  return {
    id: nextNoticeId(),
    data,
  };
}

export function computeRemainingMs(remainingMs: number, startedAtMs: number, nowMs: number): number {
  const elapsed = Math.max(0, nowMs - startedAtMs);
  return Math.max(0, remainingMs - elapsed);
}

type TimerHandle = ReturnType<typeof setTimeout>;

export interface NoticeTimerControllerOptions {
  durationMs: number;
  onTimeout: () => void;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  now?: () => number;
}

export interface NoticeTimerController {
  start(): void;
  pause(): void;
  resume(): void;
  cancel(): void;
  getRemainingMs(): number;
}

export function createNoticeTimerController(
  options: NoticeTimerControllerOptions,
): NoticeTimerController {
  const setTimer = options.setTimer ?? ((cb, delay) => globalThis.setTimeout(cb, delay));
  const clearTimer = options.clearTimer ?? ((handle) => globalThis.clearTimeout(handle));
  const now = options.now ?? (() => Date.now());

  let remainingMs = Math.max(0, options.durationMs);
  let startedAtMs: number | null = null;
  let timerHandle: TimerHandle | null = null;
  let stopped = false;

  const fire = () => {
    timerHandle = null;
    startedAtMs = null;
    remainingMs = 0;
    if (stopped) return;
    stopped = true;
    options.onTimeout();
  };

  const start = () => {
    if (stopped || timerHandle !== null) return;
    if (remainingMs <= 0) {
      fire();
      return;
    }
    startedAtMs = now();
    timerHandle = setTimer(fire, remainingMs);
  };

  const pause = () => {
    if (stopped || timerHandle === null || startedAtMs === null) return;
    clearTimer(timerHandle);
    timerHandle = null;
    remainingMs = computeRemainingMs(remainingMs, startedAtMs, now());
    startedAtMs = null;
  };

  const resume = () => {
    start();
  };

  const cancel = () => {
    stopped = true;
    if (timerHandle !== null) {
      clearTimer(timerHandle);
      timerHandle = null;
    }
    startedAtMs = null;
  };

  const getRemainingMs = () => {
    if (stopped) return 0;
    if (startedAtMs !== null) {
      return computeRemainingMs(remainingMs, startedAtMs, now());
    }
    return remainingMs;
  };

  return {
    start,
    pause,
    resume,
    cancel,
    getRemainingMs,
  };
}
