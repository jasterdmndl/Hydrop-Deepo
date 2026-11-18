import { describe, expect, it } from "vitest";
import {
  buildMonthGrid,
  createRequestTracker,
  currentManilaDateAndTime,
  formatLongDate,
  formatMonthHeading,
  formatShortDateTime,
  formatTime12h,
  scheduleDraftSignature,
  shiftMonth,
} from "./calendarView";

describe("calendar view helpers", () => {
  it("builds Sunday-first month grids with leading and trailing days", () => {
    const nov2026 = buildMonthGrid("2026-11");
    expect(nov2026).toHaveLength(35);
    expect(nov2026[0]).toEqual({ date: "2026-11-01", dayNumber: 1, inCurrentMonth: true });
    expect(nov2026[29]).toEqual({ date: "2026-11-30", dayNumber: 30, inCurrentMonth: true });
    expect(nov2026[30]).toEqual({ date: "2026-12-01", dayNumber: 1, inCurrentMonth: false });

    const aug2026 = buildMonthGrid("2026-08");
    expect(aug2026).toHaveLength(42);
    expect(aug2026[0]).toEqual({ date: "2026-07-26", dayNumber: 26, inCurrentMonth: false });
  });

  it("shifts and formats months and Manila times", () => {
    expect(shiftMonth("2026-11", -1)).toBe("2026-10");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(formatMonthHeading("2026-11")).toBe("November 2026");
    expect(formatTime12h("00:05")).toBe("12:05 AM");
    expect(formatTime12h("14:00")).toBe("2:00 PM");
    expect(formatLongDate("2026-11-12")).toBe("Thursday, November 12, 2026");
    expect(formatLongDate("2026-11-12", false)).toBe("November 12, 2026");
    expect(formatShortDateTime("2026-11-08", "16:00")).toBe("Nov 8 · 4:00 PM");
  });

  it("derives Asia/Manila date/time across UTC midnight", () => {
    const utcLate = new Date("2026-11-18T16:30:00.000Z"); // 2026-11-19 00:30+08:00
    expect(currentManilaDateAndTime(utcLate)).toEqual({
      date: "2026-11-19",
      time: "00:30",
      month: "2026-11",
    });
  });

  it("keeps the same draft signature for retries and rotates when fields change", () => {
    const a = scheduleDraftSignature({
      name: "Filter replacement",
      scheduledDate: "2026-11-12",
      scheduledTime: "14:00",
      scheduleNotes: "Replace 1-micron cartridge.",
    });
    const retry = scheduleDraftSignature({
      name: "  Filter replacement  ",
      scheduledDate: "2026-11-12",
      scheduledTime: "14:00",
      scheduleNotes: "Replace 1-micron cartridge.",
    });
    const edited = scheduleDraftSignature({
      name: "Filter replacement",
      scheduledDate: "2026-11-12",
      scheduledTime: "14:30",
      scheduleNotes: "Replace 1-micron cartridge.",
    });
    expect(a).toBe(retry);
    expect(a).not.toBe(edited);
  });

  it("ignores stale out-of-order month navigation responses in favor of the latest selected month", async () => {
    const tracker = createRequestTracker();
    const appliedMonths: string[] = [];

    let resolveDec!: (month: string) => void;
    const decPromise = new Promise<string>((resolve) => {
      resolveDec = resolve;
    });
    let resolveJan!: (month: string) => void;
    const janPromise = new Promise<string>((resolve) => {
      resolveJan = resolve;
    });

    async function loadMonth(promise: Promise<string>) {
      const requestId = tracker.next();
      const result = await promise;
      if (!tracker.isCurrent(requestId)) return;
      appliedMonths.push(result);
    }

    const req1 = loadMonth(decPromise);
    const req2 = loadMonth(janPromise);

    resolveJan("2027-01");
    await req2;
    resolveDec("2026-12");
    await req1;

    expect(appliedMonths).toEqual(["2027-01"]);
  });
});
