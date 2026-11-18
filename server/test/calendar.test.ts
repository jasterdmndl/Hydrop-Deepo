import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ManualClock } from "../src/shared/clock.js";
import { activatedAccount, createTestContext, signIn, type SignedIn, type TestContext } from "./helpers.js";

// 2026-11-09 09:00 Asia/Manila (01:00 UTC), matching the calendar reference baseline.
const BASE_MANILA = "2026-11-09T09:00:00+08:00";

async function scheduleActivity(
  ctx: TestContext,
  actor: SignedIn,
  payload: Record<string, unknown>,
) {
  return request(ctx.app)
    .post("/api/calendar/activities")
    .set("Cookie", actor.cookie)
    .set("X-CSRF-Token", actor.csrfToken)
    .send(payload);
}

async function completeActivity(
  ctx: TestContext,
  actor: SignedIn,
  reference: string,
  payload: Record<string, unknown>,
) {
  return request(ctx.app)
    .post(`/api/calendar/activities/${encodeURIComponent(reference)}/completion`)
    .set("Cookie", actor.cookie)
    .set("X-CSRF-Token", actor.csrfToken)
    .send(payload);
}

type Activated = SignedIn & { password: string };

async function reauth(ctx: TestContext, username: string, actor: Activated): Promise<Activated> {
  const fresh = await signIn(ctx.app, username, actor.password);
  return { ...fresh, password: actor.password };
}

describe("Activity Calendar records and API", () => {
  let ctx: TestContext;
  let owner: Activated;
  let cashier: Activated;

  beforeEach(async () => {
    ctx = await createTestContext({ clock: new ManualClock(BASE_MANILA) });
    owner = await activatedAccount(ctx, "owner1", "OWNER");
    cashier = await activatedAccount(ctx, "cashier1", "CASHIER");
  });

  afterEach(async () => {
    await ctx.close();
  });

  describe("role authorization and persistence", () => {
    it("allows Cashier read access and denies scheduling and completion writes with 403", async () => {
      const created = await scheduleActivity(ctx, owner, {
        requestKey: "auth-seed-1",
        name: "Filter housing cleaning",
        scheduledDate: "2026-11-12",
        scheduledTime: "14:00",
        scheduleNotes: "Clean and sanitize housing.",
      });
      expect(created.status).toBe(201);
      const ref = created.body.reference as string;

      const listRes = await request(ctx.app)
        .get("/api/calendar/activities?month=2026-11")
        .set("Cookie", cashier.cookie);
      expect(listRes.status).toBe(200);
      expect(listRes.body.scheduledActivities).toHaveLength(1);
      expect(listRes.body.scheduledActivities[0].reference).toBe(ref);

      const detailRes = await request(ctx.app)
        .get(`/api/calendar/activities/${ref}`)
        .set("Cookie", cashier.cookie);
      expect(detailRes.status).toBe(200);
      expect(detailRes.body.name).toBe("Filter housing cleaning");

      const remindersRes = await request(ctx.app)
        .get("/api/calendar/reminders")
        .set("Cookie", cashier.cookie);
      expect(remindersRes.status).toBe(200);
      expect(remindersRes.body.upcomingCount).toBe(1);

      const deniedSchedule = await scheduleActivity(ctx, cashier, {
        requestKey: "cashier-sched-attempt",
        name: "Unauthorized task",
        scheduledDate: "2026-11-13",
        scheduledTime: "10:00",
      });
      expect(deniedSchedule.status).toBe(403);
      expect(deniedSchedule.body.error.code).toBe("FORBIDDEN");

      const deniedComplete = await completeActivity(ctx, cashier, ref, {
        completedDate: "2026-11-09",
        completedTime: "08:50",
        completionNotes: "Cashier tried to complete.",
        confirmed: true,
      });
      expect(deniedComplete.status).toBe(403);
      expect(deniedComplete.body.error.code).toBe("FORBIDDEN");

      const after = await request(ctx.app)
        .get("/api/calendar/activities?month=2026-11")
        .set("Cookie", owner.cookie);
      expect(after.body.scheduledActivities).toHaveLength(1);
      expect(after.body.scheduledActivities[0].status).toBe("SCHEDULED");
      expect(after.body.completedActivities).toHaveLength(0);
    });

    it("enforces requestKey idempotency on schedule retries and rejects mismatched payload reuse", async () => {
      const payload = {
        requestKey: "sched-key-1",
        name: "UV lamp inspection",
        scheduledDate: "2026-11-12",
        scheduledTime: "14:00",
        scheduleNotes: "Inspect indicator and housing.",
      };
      const first = await scheduleActivity(ctx, owner, payload);
      expect(first.status).toBe(201);
      expect(first.body.reference).toBe("ACT-1112-01");
      expect(first.body.replayed).toBe(false);

      const retry = await scheduleActivity(ctx, owner, payload);
      expect(retry.status).toBe(200);
      expect(retry.body.replayed).toBe(true);
      expect(retry.body.reference).toBe("ACT-1112-01");

      const different = await scheduleActivity(ctx, owner, {
        requestKey: "sched-key-1",
        name: "Different activity name",
        scheduledDate: "2026-11-12",
        scheduledTime: "14:00",
      });
      expect(different.status).toBe(409);
      expect(different.body.error.code).toBe("REQUEST_KEY_CONFLICT");

      const { rows } = await ctx.db.query<{ count: string }>("SELECT COUNT(*) AS count FROM calendar_occurrences");
      expect(Number(rows[0]!.count)).toBe(1);
    });

    it("preserves one completion record on retry and concurrent submissions", async () => {
      const created = await scheduleActivity(ctx, owner, {
        requestKey: "comp-retry-seed",
        name: "Refill nozzle sanitizing",
        scheduledDate: "2026-11-09",
        scheduledTime: "11:00",
        scheduleNotes: "Sanitize all refill nozzles.",
      });
      expect(created.status).toBe(201);
      const ref = created.body.reference as string;

      ctx.clock.set("2026-11-09T11:15:00+08:00");
      owner = await reauth(ctx, "owner1", owner);
      const firstSubmit = completeActivity(ctx, owner, ref, {
        completedDate: "2026-11-09",
        completedTime: "11:10",
        completionNotes: "First recorded completion.",
        confirmed: true,
      });

      const secondSubmit = completeActivity(ctx, owner, ref, {
        completedDate: "2026-11-09",
        completedTime: "11:12",
        completionNotes: "Duplicate concurrent completion.",
        confirmed: true,
      });

      const [r1, r2] = await Promise.all([firstSubmit, secondSubmit]);
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);

      // Advance clock and submit another retry; original recorded details remain unchanged.
      ctx.clock.set("2026-11-09T12:00:00+08:00");
      owner = await reauth(ctx, "owner1", owner);
      cashier = await reauth(ctx, "cashier1", cashier);
      const laterRetry = await completeActivity(ctx, owner, ref, {
        completedDate: "2026-11-09",
        completedTime: "11:55",
        completionNotes: "Late retry overwrite attempt.",
        confirmed: true,
      });
      expect(laterRetry.status).toBe(200);

      const { rows } = await ctx.db.query<{ count: string }>("SELECT COUNT(*) AS count FROM calendar_completions");
      expect(Number(rows[0]!.count)).toBe(1);

      const detail = await request(ctx.app).get(`/api/calendar/activities/${ref}`).set("Cookie", cashier.cookie);
      expect(detail.status).toBe(200);
      expect(detail.body.status).toBe("COMPLETED");
      expect(detail.body.completionNotes).toBe("First recorded completion.");
      expect(detail.body.recordedBy).toBe("owner1");
      expect(detail.body.completion.notes).toBe("First recorded completion.");
      expect(detail.body.completion.completionNotes).toBe("First recorded completion.");
      expect(detail.body.completion.completedDate).toBe("2026-11-09");
      expect(detail.body.completion.completedTime).toBe("11:10");
      expect(detail.body.completion.recordedBy).toBe("owner1");
      expect(detail.body.completion.recordedAt).toBe("2026-11-09T11:15:00+08:00");
    });

    it("persists scheduled activities and completion history across restart", async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "hydrop-cal-restart-"));
      const clock = new ManualClock("2026-11-09T09:00:00+08:00");
      try {
        const first = await createTestContext({ dataDir: dir, clock });
        const o1 = await activatedAccount(first, "owner1", "OWNER");
        const created = await scheduleActivity(first, o1, {
          requestKey: "persist-1",
          name: "Filter replacement",
          scheduledDate: "2026-11-08",
          scheduledTime: "16:00",
          scheduleNotes: "Replace 1-micron cartridge.",
        });
        expect(created.status).toBe(201);
        const ref = created.body.reference as string;

        clock.set("2026-11-09T11:00:00+08:00");
        const o1Fresh = await reauth(first, "owner1", o1);
        const completed = await completeActivity(first, o1Fresh, ref, {
          completedDate: "2026-11-09",
          completedTime: "10:50",
          completionNotes: "Replaced and flushed.",
          confirmed: true,
        });
        expect(completed.status).toBe(200);
        await first.close();

        const second = await createTestContext({ dataDir: dir, clock });
        try {
          const c2 = await activatedAccount(second, "cashier2", "CASHIER");
          const list = await request(second.app)
            .get("/api/calendar/activities?month=2026-11")
            .set("Cookie", c2.cookie);
          expect(list.status).toBe(200);
          expect(list.body.scheduledActivities).toHaveLength(1);
          expect(list.body.completedActivities).toHaveLength(1);
          expect(list.body.completedActivities[0]).toMatchObject({
            reference: ref,
            name: "Filter replacement",
            scheduleNotes: "Replace 1-micron cartridge.",
            status: "COMPLETED",
            completion: {
              completedDate: "2026-11-09",
              completedTime: "10:50",
              notes: "Replaced and flushed.",
              recordedBy: "owner1",
              recordedAt: "2026-11-09T11:00:00+08:00",
            },
          });
        } finally {
          await second.close();
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe("same-time conflicts and completion validation", () => {
    it("allows same-day different times directly and requires fresh confirmation for current conflict set", async () => {
      const morning = await scheduleActivity(ctx, owner, {
        requestKey: "c-1",
        name: "Water quality check",
        scheduledDate: "2026-11-12",
        scheduledTime: "09:00",
      });
      expect(morning.status).toBe(201);

      const afternoon = await scheduleActivity(ctx, owner, {
        requestKey: "c-2",
        name: "UV lamp inspection",
        scheduledDate: "2026-11-12",
        scheduledTime: "14:00",
      });
      expect(afternoon.status).toBe(201);
      const ref1400 = afternoon.body.reference as string;

      // Same date and time returns 409 SCHEDULE_CONFLICT until explicitly continued.
      const conflict1 = await scheduleActivity(ctx, owner, {
        requestKey: "c-3",
        name: "Pipe check",
        scheduledDate: "2026-11-12",
        scheduledTime: "14:00",
      });
      expect(conflict1.status).toBe(409);
      expect(conflict1.body.error.code).toBe("SCHEDULE_CONFLICT");
      expect(conflict1.body.conflictReferences).toEqual([ref1400]);

      const confirmed = await scheduleActivity(ctx, owner, {
        requestKey: "c-3",
        name: "Pipe check",
        scheduledDate: "2026-11-12",
        scheduledTime: "14:00",
        acknowledgedConflictReferences: [ref1400],
      });
      expect(confirmed.status).toBe(201);
      const refPipe = confirmed.body.reference as string;

      // Stale confirmation acknowledging only ref1400 fails because refPipe now also shares 14:00.
      const staleConfirm = await scheduleActivity(ctx, owner, {
        requestKey: "c-4",
        name: "Valve inspection",
        scheduledDate: "2026-11-12",
        scheduledTime: "14:00",
        acknowledgedConflictReferences: [ref1400],
      });
      expect(staleConfirm.status).toBe(409);
      expect(staleConfirm.body.error.code).toBe("SCHEDULE_CONFLICT");
      expect(staleConfirm.body.conflictReferences).toEqual([ref1400, refPipe]);

      const currentConfirm = await scheduleActivity(ctx, owner, {
        requestKey: "c-4",
        name: "Valve inspection",
        scheduledDate: "2026-11-12",
        scheduledTime: "14:00",
        acknowledgedConflictReferences: [ref1400, refPipe],
      });
      expect(currentConfirm.status).toBe(201);

      // Completed occurrences do not block scheduling at that time.
      ctx.clock.set("2026-11-09T09:10:00+08:00");
      const completeMorning = await completeActivity(ctx, owner, morning.body.reference, {
        completedDate: "2026-11-09",
        completedTime: "09:05",
        completionNotes: "Completed early.",
        confirmed: true,
      });
      expect(completeMorning.status).toBe(200);

      const reuse0900 = await scheduleActivity(ctx, owner, {
        requestKey: "c-5",
        name: "Follow-up quality check",
        scheduledDate: "2026-11-12",
        scheduledTime: "09:00",
      });
      expect(reuse0900.status).toBe(201);
    });

    it("enforces conflict detection when two unconfirmed schedules race at the same time", async () => {
      const first = scheduleActivity(ctx, owner, {
        requestKey: "race-1",
        name: "Concurrent task A",
        scheduledDate: "2026-11-13",
        scheduledTime: "10:00",
      });
      const second = scheduleActivity(ctx, owner, {
        requestKey: "race-2",
        name: "Concurrent task B",
        scheduledDate: "2026-11-13",
        scheduledTime: "10:00",
      });

      const results = await Promise.all([first, second]);
      const statuses = results.map((r) => r.status).sort((a, b) => a - b);
      expect(statuses).toEqual([201, 409]);

      const winner = results.find((r) => r.status === 201)!;
      const loser = results.find((r) => r.status === 409)!;
      expect(loser.body.error.code).toBe("SCHEDULE_CONFLICT");
      expect(loser.body.conflictReferences).toEqual([winner.body.reference]);
    });

    it("supports genuine early and late completion while preserving original schedule", async () => {
      const future = await scheduleActivity(ctx, owner, {
        requestKey: "early-1",
        name: "Storage tank cleaning",
        scheduledDate: "2026-11-14",
        scheduledTime: "08:00",
        scheduleNotes: "Drain and scrub main tank.",
      });
      expect(future.status).toBe(201);
      const futureRef = future.body.reference as string;

      const overdue = await scheduleActivity(ctx, owner, {
        requestKey: "late-1",
        name: "Filter housing cleaning",
        scheduledDate: "2026-11-08",
        scheduledTime: "16:00",
        scheduleNotes: "Sanitize filter housing.",
      });
      expect(overdue.status).toBe(201);
      const overdueRef = overdue.body.reference as string;

      // Early completion on Nov 12 before Nov 14 schedule.
      ctx.clock.set("2026-11-12T10:30:00+08:00");
      owner = await reauth(ctx, "owner1", owner);
      const earlyDone = await completeActivity(ctx, owner, futureRef, {
        completedDate: "2026-11-12",
        completedTime: "10:00",
        completionNotes: "Finished early during slow hour.",
        confirmed: true,
      });
      expect(earlyDone.status).toBe(200);
      expect(earlyDone.body.scheduledDate).toBe("2026-11-14");
      expect(earlyDone.body.scheduledTime).toBe("08:00");
      expect(earlyDone.body.scheduleNotes).toBe("Drain and scrub main tank.");
      expect(earlyDone.body.completion).toMatchObject({
        completedDate: "2026-11-12",
        completedTime: "10:00",
        notes: "Finished early during slow hour.",
        recordedBy: "owner1",
        recordedAt: "2026-11-12T10:30:00+08:00",
      });

      // Late completion for Nov 8 activity.
      const lateDone = await completeActivity(ctx, owner, overdueRef, {
        completedDate: "2026-11-09",
        completedTime: "10:50",
        completionNotes: "Cleaned and checked seals.",
        confirmed: true,
      });
      expect(lateDone.status).toBe(200);
      expect(lateDone.body.scheduledDate).toBe("2026-11-08");
      expect(lateDone.body.scheduledTime).toBe("16:00");
      expect(lateDone.body.completion.completedDate).toBe("2026-11-09");
      expect(lateDone.body.completion.completedTime).toBe("10:50");

      const reminders = await request(ctx.app).get("/api/calendar/reminders").set("Cookie", owner.cookie);
      expect(reminders.status).toBe(200);
      expect(reminders.body).toEqual({ upcomingCount: 0, overdueCount: 0, items: [] });
    });

    it("rejects future completion time, blank required values, and missing confirmation", async () => {
      const created = await scheduleActivity(ctx, owner, {
        requestKey: "val-seed",
        name: "Nozzle sanitizing",
        scheduledDate: "2026-11-09",
        scheduledTime: "11:00",
      });
      const ref = created.body.reference as string;

      // Blank activity name
      const blankName = await scheduleActivity(ctx, owner, {
        requestKey: "val-blank-name",
        name: "   ",
        scheduledDate: "2026-11-10",
        scheduledTime: "09:00",
      });
      expect(blankName.status).toBe(400);
      expect(blankName.body.error.code).toBe("VALIDATION_FAILED");

      // Invalid date
      const badDate = await scheduleActivity(ctx, owner, {
        requestKey: "val-bad-date",
        name: "Task",
        scheduledDate: "2026-02-30",
        scheduledTime: "09:00",
      });
      expect(badDate.status).toBe(400);
      expect(badDate.body.error.code).toBe("VALIDATION_FAILED");

      // Future completion time (server clock is 2026-11-09 09:00+08:00)
      const futureTime = await completeActivity(ctx, owner, ref, {
        completedDate: "2026-11-09",
        completedTime: "09:01",
        completionNotes: "Done in the future.",
        confirmed: true,
      });
      expect(futureTime.status).toBe(400);
      expect(futureTime.body.error.code).toBe("VALIDATION_FAILED");

      // Blank completion notes
      const blankNotes = await completeActivity(ctx, owner, ref, {
        completedDate: "2026-11-09",
        completedTime: "08:55",
        completionNotes: "   ",
        confirmed: true,
      });
      expect(blankNotes.status).toBe(400);
      expect(blankNotes.body.error.code).toBe("VALIDATION_FAILED");

      // Missing confirmation
      const unconfirmed = await completeActivity(ctx, owner, ref, {
        completedDate: "2026-11-09",
        completedTime: "08:55",
        completionNotes: "Did the work.",
        confirmed: false,
      });
      expect(unconfirmed.status).toBe(400);
      expect(unconfirmed.body.error.code).toBe("VALIDATION_FAILED");
    });

    it("rejects impossible ISO calendar dates for scheduling and completion with no database write", async () => {
      const seed = await scheduleActivity(ctx, owner, {
        requestKey: "iso-bad-seed",
        name: "Seed task",
        scheduledDate: "2026-11-09",
        scheduledTime: "10:00",
      });
      expect(seed.status).toBe(201);
      const seedRef = seed.body.reference as string;

      for (const badIso of [
        "2026-02-30T09:00:00+08:00",
        "2026-02-29T09:00:00+08:00",
        "2026-04-31T09:00:00+08:00",
      ]) {
        const badSchedule = await scheduleActivity(ctx, owner, {
          requestKey: `bad-iso-${badIso}`,
          name: "Impossible date task",
          scheduledAt: badIso,
        });
        expect(badSchedule.status).toBe(400);
        expect(badSchedule.body.error.code).toBe("VALIDATION_FAILED");
      }

      const { rows: occCount } = await ctx.db.query<{ count: string }>("SELECT COUNT(*) AS count FROM calendar_occurrences");
      expect(Number(occCount[0]!.count)).toBe(1);

      for (const payload of [
        { completedAt: "2026-02-30T09:00:00+08:00" },
        { actualCompletedAt: "2026-02-29T09:00:00+08:00" },
      ]) {
        const badComplete = await completeActivity(ctx, owner, seedRef, {
          ...payload,
          completionNotes: "Attempted impossible completion date.",
          confirmed: true,
        });
        expect(badComplete.status).toBe(400);
        expect(badComplete.body.error.code).toBe("VALIDATION_FAILED");
      }

      const detail = await request(ctx.app).get(`/api/calendar/activities/${seedRef}`).set("Cookie", owner.cookie);
      expect(detail.status).toBe(200);
      expect(detail.body.completion).toBeNull();
    });

    it("normalizes scheduling timestamps to whole minutes for conflicts, persistence, and requestKey replay", async () => {
      const first = await scheduleActivity(ctx, owner, {
        requestKey: "minute-1",
        name: "Pump check",
        scheduledDate: "2026-11-12",
        scheduledTime: "10:00",
      });
      expect(first.status).toBe(201);
      expect(first.body.scheduledAt).toBe("2026-11-12T10:00:00+08:00");
      const firstRef = first.body.reference as string;

      // Scheduling 10:00:30 via ISO hits the same 10:00 minute and triggers conflict detection.
      const subMinuteConflict = await scheduleActivity(ctx, owner, {
        requestKey: "minute-2",
        name: "Meter reading",
        scheduledAt: "2026-11-12T10:00:30+08:00",
      });
      expect(subMinuteConflict.status).toBe(409);
      expect(subMinuteConflict.body.error.code).toBe("SCHEDULE_CONFLICT");
      expect(subMinuteConflict.body.conflictReferences).toEqual([firstRef]);

      // Confirming the conflict persists normalized to the whole minute 10:00:00+08:00.
      const confirmed = await scheduleActivity(ctx, owner, {
        requestKey: "minute-2",
        name: "Meter reading",
        scheduledAt: "2026-11-12T10:00:30+08:00",
        acknowledgedConflictReferences: [firstRef],
      });
      expect(confirmed.status).toBe(201);
      expect(confirmed.body.scheduledAt).toBe("2026-11-12T10:00:00+08:00");
      expect(confirmed.body.scheduledTime).toBe("10:00");

      // Replaying the same requestKey within the same whole minute returns the existing record.
      const replay = await scheduleActivity(ctx, owner, {
        requestKey: "minute-2",
        name: "Meter reading",
        scheduledAt: "2026-11-12T10:00:45+08:00",
      });
      expect(replay.status).toBe(200);
      expect(replay.body.replayed).toBe(true);
      expect(replay.body.reference).toBe(confirmed.body.reference);
    });

    it("filters scheduled and completed lists by Asia/Manila month across UTC month boundaries", async () => {
      const octCtx = await createTestContext({ clock: new ManualClock("2026-10-31T23:00:00+08:00") });
      try {
        let octOwner = await activatedAccount(octCtx, "owner1", "OWNER");
        let octCashier = await activatedAccount(octCtx, "cashier1", "CASHIER");

        // 2026-10-31 23:30+08:00 (15:30Z) scheduled in October Manila time.
        const created = await scheduleActivity(octCtx, octOwner, {
          requestKey: "cross-month-1",
          name: "Month-end tank flush",
          scheduledDate: "2026-10-31",
          scheduledTime: "23:30",
        });
        expect(created.status).toBe(201);
        const ref = created.body.reference as string;

        // 2026-11-01 00:30+08:00 is still 2026-10-31T16:30:00Z in UTC, but November in Asia/Manila!
        octCtx.clock.set("2026-11-01T00:45:00+08:00");
        octOwner = await reauth(octCtx, "owner1", octOwner);
        octCashier = await reauth(octCtx, "cashier1", octCashier);
        const done = await completeActivity(octCtx, octOwner, ref, {
          completedDate: "2026-11-01",
          completedTime: "00:30",
          completionNotes: "Flushed after midnight Manila time.",
          confirmed: true,
        });
        expect(done.status).toBe(200);

        const oct = await request(octCtx.app).get("/api/calendar/activities?month=2026-10").set("Cookie", octCashier.cookie);
        expect(oct.status).toBe(200);
        expect(oct.body.scheduledActivities.map((a: any) => a.reference)).toEqual([ref]);
        expect(oct.body.completedActivities).toEqual([]);

        const nov = await request(octCtx.app).get("/api/calendar/activities?month=2026-11").set("Cookie", octCashier.cookie);
        expect(nov.status).toBe(200);
        expect(nov.body.scheduledActivities).toEqual([]);
        expect(nov.body.completedActivities.map((a: any) => a.reference)).toEqual([ref]);
      } finally {
        await octCtx.close();
      }
    });
  });

  describe("Asia/Manila reminder window boundaries", () => {
    it("enforces exact overdue, now, and 7th-following-day midnight cutoffs", async () => {
      // Clock fixed at 2026-11-09 09:00:00+08:00.
      const beforeNow = await scheduleActivity(ctx, owner, {
        requestKey: "rem-before",
        name: "Just overdue",
        scheduledDate: "2026-11-09",
        scheduledTime: "08:59",
      });
      const atNow = await scheduleActivity(ctx, owner, {
        requestKey: "rem-now",
        name: "Due right now",
        scheduledDate: "2026-11-09",
        scheduledTime: "09:00",
      });
      const day6Late = await scheduleActivity(ctx, owner, {
        requestKey: "rem-day6",
        name: "End of 6th following day",
        scheduledDate: "2026-11-15",
        scheduledTime: "23:59",
      });
      const day7Midnight = await scheduleActivity(ctx, owner, {
        requestKey: "rem-day7",
        name: "Start of 7th following day",
        scheduledDate: "2026-11-16",
        scheduledTime: "00:00",
      });

      expect(beforeNow.status).toBe(201);
      expect(atNow.status).toBe(201);
      expect(day6Late.status).toBe(201);
      expect(day7Midnight.status).toBe(201);

      const rem1 = await request(ctx.app).get("/api/calendar/reminders").set("Cookie", cashier.cookie);
      expect(rem1.status).toBe(200);
      expect(rem1.body.overdueCount).toBe(1);
      expect(rem1.body.upcomingCount).toBe(2);
      expect(rem1.body.items.map((item: any) => [item.reference, item.status])).toEqual([
        [beforeNow.body.reference, "OVERDUE"],
        [atNow.body.reference, "UPCOMING"],
        [day6Late.body.reference, "UPCOMING"],
      ]);

      // Advance clock 1 minute past 09:00 -> atNow moves from upcoming to overdue without completing.
      ctx.clock.set("2026-11-09T09:01:00+08:00");
      const rem2 = await request(ctx.app).get("/api/calendar/reminders").set("Cookie", cashier.cookie);
      expect(rem2.body.overdueCount).toBe(2);
      expect(rem2.body.upcomingCount).toBe(1);
      expect(rem2.body.items.map((item: any) => [item.reference, item.status])).toEqual([
        [beforeNow.body.reference, "OVERDUE"],
        [atNow.body.reference, "OVERDUE"],
        [day6Late.body.reference, "UPCOMING"],
      ]);

      const atNowDetail = await request(ctx.app)
        .get(`/api/calendar/activities/${atNow.body.reference}`)
        .set("Cookie", cashier.cookie);
      expect(atNowDetail.body.status).toBe("OVERDUE");
      expect(atNowDetail.body.completion).toBeNull();

      // Advance clock to 2026-11-09T16:00:00Z (2026-11-10 00:00:00+08:00) -> day7Midnight enters upcoming window.
      ctx.clock.set("2026-11-10T00:00:00+08:00");
      cashier = await reauth(ctx, "cashier1", cashier);
      const rem3 = await request(ctx.app).get("/api/calendar/reminders").set("Cookie", cashier.cookie);
      expect(rem3.body.overdueCount).toBe(2);
      expect(rem3.body.upcomingCount).toBe(2);
      expect(rem3.body.items.map((item: any) => item.reference)).toContain(day7Midnight.body.reference);
    });
  });
});
