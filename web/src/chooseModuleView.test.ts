import { describe, expect, it } from "vitest";
import type { RemindersResponse } from "./calendar/calendarView";
import {
  buildOverdueAttention,
  collectPendingPaymentReferences,
  formatDueDateForCallout,
  formatManilaBannerDate,
  formatManilaFullDate,
  manilaGreeting,
  orderSidebarModules,
  selectHomeCardModules,
} from "./chooseModuleView";
import type { PendingCheckoutRecovery, PosDayResponse } from "./pos/posRecovery";

function makeRecovery(reference: string): PendingCheckoutRecovery {
  return {
    reference,
    businessDate: "2026-11-20",
    initiatedBy: "cashier.demo",
    items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 1 }],
    quoteItems: [],
    totalCentavos: 2500,
    totalContainers: 1,
    totalVolumeMl: 25_000,
    totalVolumeLiters: 25,
    cashReceivedCentavos: 10_000,
    changeCentavos: 7500,
    attemptedAt: "2026-11-20T09:00:00+08:00",
    lastLookup: null,
    lastError: null,
  };
}

describe("chooseModuleView helpers", () => {
  it("computes Asia/Manila greetings across UTC midnight boundaries", () => {
    // 16:00 UTC -> 00:00+08:00 (midnight Manila)
    expect(manilaGreeting(new Date("2026-11-19T16:00:00.000Z"))).toBe("Good morning");
    // 00:30 UTC -> 08:30+08:00
    expect(manilaGreeting(new Date("2026-11-20T00:30:00.000Z"))).toBe("Good morning");
    // 04:00 UTC -> 12:00+08:00
    expect(manilaGreeting(new Date("2026-11-20T04:00:00.000Z"))).toBe("Good afternoon");
    // 09:59 UTC -> 17:59+08:00
    expect(manilaGreeting(new Date("2026-11-20T09:59:00.000Z"))).toBe("Good afternoon");
    // 10:00 UTC -> 18:00+08:00
    expect(manilaGreeting(new Date("2026-11-20T10:00:00.000Z"))).toBe("Good evening");
    // 15:59 UTC -> 23:59+08:00
    expect(manilaGreeting(new Date("2026-11-20T15:59:00.000Z"))).toBe("Good evening");
  });

  it("formats full and banner Asia/Manila dates across UTC midnight", () => {
    const utcLate = new Date("2026-11-19T16:30:00.000Z"); // Friday, Nov 20, 2026 00:30+08:00
    expect(formatManilaFullDate(utcLate)).toBe("Friday, November 20, 2026");
    expect(formatManilaBannerDate(utcLate)).toBe("Friday, November 20");
  });

  it("formats overdue callout due dates with year only when different from current Manila year", () => {
    const now = new Date("2026-11-20T01:00:00.000Z");
    expect(formatDueDateForCallout("2026-11-08", now)).toBe("November 8");
    expect(formatDueDateForCallout("2025-12-31", now)).toBe("December 31, 2025");
    expect(formatDueDateForCallout("invalid-date", now)).toBe("invalid-date");
  });

  it("orders sidebar modules with Inventory fourth and selects all four home cards", () => {
    const serverOrder = [
      { key: "pos", name: "POS" },
      { key: "dashboard", name: "Dashboard" },
      { key: "calendar", name: "Activity Calendar" },
      { key: "inventory", name: "Inventory" },
    ];

    expect(orderSidebarModules(serverOrder).map((m) => m.key)).toEqual([
      "dashboard",
      "pos",
      "calendar",
      "inventory",
    ]);
    expect(selectHomeCardModules(serverOrder).map((m) => m.key)).toEqual([
      "pos",
      "dashboard",
      "calendar",
      "inventory",
    ]);
  });

  it("builds role-specific overdue attention messages and omits when none overdue", () => {
    const now = new Date("2026-11-20T01:00:00.000Z");

    const noneOverdue: RemindersResponse = {
      upcomingCount: 2,
      overdueCount: 0,
      items: [
        {
          reference: "ACT-1121-01",
          name: "Water quality check",
          scheduledAt: "2026-11-21T09:00:00+08:00",
          scheduledDate: "2026-11-21",
          scheduledTime: "09:00",
          scheduleNotes: null,
          status: "UPCOMING",
        },
      ],
    };
    expect(buildOverdueAttention(null, "OWNER", now)).toBeNull();
    expect(buildOverdueAttention(noneOverdue, "OWNER", now)).toBeNull();

    const oneOverdue: RemindersResponse = {
      upcomingCount: 3,
      overdueCount: 1,
      items: [
        {
          reference: "ACT-1108-01",
          name: "Filter housing cleaning",
          scheduledAt: "2026-11-08T16:00:00+08:00",
          scheduledDate: "2026-11-08",
          scheduledTime: "16:00",
          scheduleNotes: null,
          status: "OVERDUE",
        },
      ],
    };
    expect(buildOverdueAttention(oneOverdue, "OWNER", now)).toEqual({
      title: "One activity needs your attention",
      body: "Filter housing cleaning was due November 8. Open Activity Calendar to review and record completion.",
      overdueCount: 1,
    });
    expect(buildOverdueAttention(oneOverdue, "CASHIER", now)).toEqual({
      title: "One activity needs your attention",
      body: "Filter housing cleaning was due November 8. Open Activity Calendar to view details. Only the Owner can record completion.",
      overdueCount: 1,
    });

    const multiOverdue: RemindersResponse = {
      upcomingCount: 1,
      overdueCount: 3,
      items: [
        ...oneOverdue.items,
        {
          reference: "ACT-1110-01",
          name: "Tank flushing",
          scheduledAt: "2026-11-10T10:00:00+08:00",
          scheduledDate: "2026-11-10",
          scheduledTime: "10:00",
          scheduleNotes: null,
          status: "OVERDUE",
        },
      ],
    };
    expect(buildOverdueAttention(multiOverdue, "OWNER", now)).toEqual({
      title: "3 activities need your attention",
      body: "Filter housing cleaning was due November 8 (+2 more overdue). Open Activity Calendar to review and record completion.",
      overdueCount: 3,
    });
    expect(buildOverdueAttention(multiOverdue, "CASHIER", now)).toEqual({
      title: "3 activities need your attention",
      body: "Filter housing cleaning was due November 8 (+2 more overdue). Open Activity Calendar to view details. Only the Owner can record completion.",
      overdueCount: 3,
    });
  });

  it("collects and deduplicates local and server pending payment references", () => {
    const posDay: PosDayResponse = {
      state: "OPEN",
      todayDate: "2026-11-20",
      canStartDay: false,
      canSell: true,
      canEndDay: true,
      day: null,
      unpaidDrafts: [],
      unresolvedCheckouts: [
        {
          reference: "hd-1120-001",
          businessDate: "2026-11-20",
          status: "PAYMENT_PENDING",
          createdBy: "cashier.demo",
          createdAt: "2026-11-20T09:00:00+08:00",
          updatedAt: "2026-11-20T09:00:00+08:00",
          totalCentavos: 2500,
          totalContainers: 1,
          totalVolumeMl: 25_000,
          totalVolumeLiters: 25,
          cashReceivedCentavos: null,
          changeCentavos: null,
          paymentStartedAt: "2026-11-20T09:00:00+08:00",
          paymentRecordedAt: null,
          resolutionReason: null,
          items: [],
        },
        {
          reference: "HD-1120-002",
          businessDate: "2026-11-20",
          status: "PAYMENT_PENDING",
          createdBy: "owner.demo",
          createdAt: "2026-11-20T09:05:00+08:00",
          updatedAt: "2026-11-20T09:05:00+08:00",
          totalCentavos: 5000,
          totalContainers: 2,
          totalVolumeMl: 50_000,
          totalVolumeLiters: 50,
          cashReceivedCentavos: null,
          changeCentavos: null,
          paymentStartedAt: "2026-11-20T09:05:00+08:00",
          paymentRecordedAt: null,
          resolutionReason: null,
          items: [],
        },
      ],
    };

    expect(collectPendingPaymentReferences([makeRecovery("HD-1120-001")], posDay)).toEqual([
      "HD-1120-001",
      "HD-1120-002",
    ]);
    expect(collectPendingPaymentReferences([], null)).toEqual([]);
  });
});
