import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeRemainingMs,
  createNoticeTimerController,
  nextNoticeId,
  NOTICE_DURATION_MS,
  wrapNotice,
} from "./noticeTiming";

describe("noticeTiming", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-23T10:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses 8s for brief notices and 15s for detailed notices", () => {
    expect(NOTICE_DURATION_MS.brief).toBe(8_000);
    expect(NOTICE_DURATION_MS.detailed).toBe(15_000);
  });

  it("assigns distinct monotonic occurrence IDs even for identical messages", () => {
    const first = wrapNotice("Same saved message");
    const second = wrapNotice("Same saved message");
    const thirdId = nextNoticeId();

    expect(second.id).toBeGreaterThan(first.id);
    expect(thirdId).toBeGreaterThan(second.id);
    expect(first.data).toBe(second.data);
  });

  it("computes clamped remaining durations", () => {
    expect(computeRemainingMs(8_000, 1_000, 3_500)).toBe(5_500);
    expect(computeRemainingMs(8_000, 1_000, 12_000)).toBe(0);
    expect(computeRemainingMs(8_000, 5_000, 4_000)).toBe(8_000);
  });

  it("auto-dismisses brief and detailed notices after their configured timeout", () => {
    const onBriefTimeout = vi.fn();
    const onDetailedTimeout = vi.fn();

    const brief = createNoticeTimerController({
      durationMs: NOTICE_DURATION_MS.brief,
      onTimeout: onBriefTimeout,
    });
    const detailed = createNoticeTimerController({
      durationMs: NOTICE_DURATION_MS.detailed,
      onTimeout: onDetailedTimeout,
    });

    brief.start();
    detailed.start();

    vi.advanceTimersByTime(7_999);
    expect(onBriefTimeout).not.toHaveBeenCalled();
    expect(onDetailedTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onBriefTimeout).toHaveBeenCalledTimes(1);
    expect(onDetailedTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(6_999);
    expect(onDetailedTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onDetailedTimeout).toHaveBeenCalledTimes(1);
  });

  it("pauses while hovered or focused and resumes only for the remaining duration", () => {
    const onTimeout = vi.fn();
    const controller = createNoticeTimerController({
      durationMs: NOTICE_DURATION_MS.brief,
      onTimeout,
    });

    controller.start();
    vi.advanceTimersByTime(3_000);
    expect(controller.getRemainingMs()).toBe(5_000);

    controller.pause();
    vi.advanceTimersByTime(20_000);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(controller.getRemainingMs()).toBe(5_000);

    controller.resume();
    vi.advanceTimersByTime(4_999);
    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(controller.getRemainingMs()).toBe(0);
  });

  it("cancels cleanly without firing and keeps separate notices independent", () => {
    const onFirst = vi.fn();
    const onSecond = vi.fn();

    const first = createNoticeTimerController({
      durationMs: NOTICE_DURATION_MS.brief,
      onTimeout: onFirst,
    });
    const second = createNoticeTimerController({
      durationMs: NOTICE_DURATION_MS.detailed,
      onTimeout: onSecond,
    });

    first.start();
    second.start();

    vi.advanceTimersByTime(2_000);
    first.cancel();

    vi.advanceTimersByTime(13_000);
    expect(onFirst).not.toHaveBeenCalled();
    expect(onSecond).toHaveBeenCalledTimes(1);
  });
});
