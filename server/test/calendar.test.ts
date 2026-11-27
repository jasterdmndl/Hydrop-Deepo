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

async function patchActivity(
  ctx: TestContext,
  actor: SignedIn,
  reference: string,
  payload: Record<string, unknown>,
) {
  return request(ctx.app)
    .patch(`/api/calendar/activities/${encodeURIComponent(reference)}`)
    .set("Cookie", actor.cookie)
    .set("X-CSRF-Token", actor.csrfToken)
    .send(payload);
}

async function cancelActivity(
  ctx: TestContext,
  actor: SignedIn,
  reference: string,
  payload: Record<string, unknown>,
) {
  return request(ctx.app)
    .post(`/api/calendar/activities/${encodeURIComponent(reference)}/cancellation`)
    .set("Cookie", actor.cookie)
    .set("X-CSRF-Token", actor.csrfToken)
    .send(payload);
}

async function patchCompletion(
  ctx: TestContext,
  actor: SignedIn,
  reference: string,
  payload: Record<string, unknown>,
) {
  return request(ctx.app)
    .patch(`/api/calendar/activities/${encodeURIComponent(reference)}/completion`)
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
    cashier = await activatedAccount(ctx, "cashier1", "EMPLOYEE");
  });

  afterEach(async () => {
    await ctx.close();
  });

  describe("role authorization and persistence", () => {
    it("allows Employee read access and denies scheduling and completion writes with 403", async () => {
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
          const c2 = await activatedAccount(second, "cashier2", "EMPLOYEE");
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
        let octCashier = await activatedAccount(octCtx, "cashier1", "EMPLOYEE");

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

  describe("repeating activities (Task 1)", () => {
    it("schedules inclusive Daily and Weekly occurrences with stable references and series metadata", async () => {
      const daily = await scheduleActivity(ctx, owner, {
        requestKey: "rep-daily-1",
        name: "Backwash sand filter",
        scheduledDate: "2026-11-10",
        scheduledTime: "08:30",
        scheduleNotes: "Run 10-minute backwash cycle.",
        recurrence: "DAILY",
        endDate: "2026-11-12",
      });
      expect(daily.status).toBe(201);
      expect(daily.body.replayed).toBe(false);
      expect(daily.body.series).toMatchObject({
        recurrence: "DAILY",
        startDate: "2026-11-10",
        endDate: "2026-11-12",
        scheduledTime: "08:30",
        occurrenceCount: 3,
      });
      expect(daily.body.series.reference).toMatch(/^SER-\d{4}-\d{2,}$/);
      const dailySeriesRef = daily.body.series.reference as string;
      expect(daily.body.activities).toHaveLength(3);
      expect(daily.body.activities.map((a: any) => a.scheduledDate)).toEqual([
        "2026-11-10",
        "2026-11-11",
        "2026-11-12",
      ]);
      expect(daily.body.activities.map((a: any) => a.scheduledTime)).toEqual(["08:30", "08:30", "08:30"]);
      expect(daily.body.activities.map((a: any) => a.seriesIndex)).toEqual([1, 2, 3]);
      expect(daily.body.activities.every((a: any) => a.seriesReference === dailySeriesRef)).toBe(true);
      expect(daily.body.activities.every((a: any) => a.recurrence === "DAILY")).toBe(true);
      expect(daily.body.activities.every((a: any) => a.seriesEndDate === "2026-11-12")).toBe(true);
      expect(daily.body.activities.map((a: any) => a.reference)).toEqual([
        "ACT-1110-01",
        "ACT-1111-01",
        "ACT-1112-01",
      ]);
      expect(daily.body.series.occurrenceReferences).toEqual([
        "ACT-1110-01",
        "ACT-1111-01",
        "ACT-1112-01",
      ]);
      expect(daily.body.reference).toBe("ACT-1110-01");
      expect(daily.body.activity.reference).toBe("ACT-1110-01");

      // Single-day repeating (startDate === endDate) creates exactly 1 occurrence.
      const singleDayRepeat = await scheduleActivity(ctx, owner, {
        requestKey: "rep-daily-single",
        name: "Single-day repeating check",
        scheduledDate: "2026-11-14",
        scheduledTime: "11:00",
        recurrence: "DAILY",
        endDate: "2026-11-14",
      });
      expect(singleDayRepeat.status).toBe(201);
      expect(singleDayRepeat.body.activities).toHaveLength(1);
      expect(singleDayRepeat.body.activities[0].scheduledDate).toBe("2026-11-14");
      expect(singleDayRepeat.body.series.occurrenceCount).toBe(1);

      // Weekly from Monday 2026-11-09 through Wednesday 2026-11-25 creates 3 Mondays.
      const weekly = await scheduleActivity(ctx, owner, {
        requestKey: "rep-weekly-1",
        name: "Weekly brine tank refill",
        scheduledDate: "2026-11-09",
        scheduledTime: "14:00",
        recurrence: "WEEKLY",
        endDate: "2026-11-25",
      });
      expect(weekly.status).toBe(201);
      expect(weekly.body.activities.map((a: any) => a.scheduledDate)).toEqual([
        "2026-11-09",
        "2026-11-16",
        "2026-11-23",
      ]);
      expect(weekly.body.activities.every((a: any) => a.scheduledTime === "14:00")).toBe(true);
      expect(weekly.body.series.recurrence).toBe("WEEKLY");

      // Weekly where endDate lands on the same weekday includes endDate.
      const weeklyExact = await scheduleActivity(ctx, owner, {
        requestKey: "rep-weekly-exact",
        name: "Weekly Tuesday UV check",
        scheduledDate: "2026-11-10",
        scheduledTime: "15:00",
        recurrence: "WEEKLY",
        endDate: "2026-11-24",
      });
      expect(weeklyExact.status).toBe(201);
      expect(weeklyExact.body.activities.map((a: any) => a.scheduledDate)).toEqual([
        "2026-11-10",
        "2026-11-17",
        "2026-11-24",
      ]);
    });

    it("clamps Monthly 31st schedules across leap and non-leap February and returns to the 31st", async () => {
      const leap2028 = await scheduleActivity(ctx, owner, {
        requestKey: "rep-monthly-leap",
        name: "Monthly deep tank sanitize",
        scheduledDate: "2028-01-31",
        scheduledTime: "09:00",
        recurrence: "MONTHLY",
        endDate: "2028-03-31",
      });
      expect(leap2028.status).toBe(201);
      expect(leap2028.body.activities.map((a: any) => a.scheduledDate)).toEqual([
        "2028-01-31",
        "2028-02-29",
        "2028-03-31",
      ]);
      expect(leap2028.body.activities.every((a: any) => a.scheduledTime === "09:00")).toBe(true);

      const nonLeap2027 = await scheduleActivity(ctx, owner, {
        requestKey: "rep-monthly-nonleap",
        name: "Monthly membrane flush",
        scheduledDate: "2027-01-31",
        scheduledTime: "10:30",
        recurrence: "MONTHLY",
        endDate: "2027-04-30",
      });
      expect(nonLeap2027.status).toBe(201);
      expect(nonLeap2027.body.activities.map((a: any) => a.scheduledDate)).toEqual([
        "2027-01-31",
        "2027-02-28",
        "2027-03-31",
        "2027-04-30",
      ]);

      // End date before Feb 28 excludes February when clamped date would exceed endDate.
      const beforeFebEnd = await scheduleActivity(ctx, owner, {
        requestKey: "rep-monthly-cutoff",
        name: "Monthly cutoff check",
        scheduledDate: "2027-01-31",
        scheduledTime: "13:00",
        recurrence: "MONTHLY",
        endDate: "2027-02-27",
      });
      expect(beforeFebEnd.status).toBe(201);
      expect(beforeFebEnd.body.activities.map((a: any) => a.scheduledDate)).toEqual(["2027-01-31"]);
    });

    it("validates recurrence and endDate rules without writing partial records", async () => {
      const missingEndDate = await scheduleActivity(ctx, owner, {
        requestKey: "val-rep-missing-end",
        name: "Daily check",
        scheduledDate: "2026-11-10",
        scheduledTime: "09:00",
        recurrence: "DAILY",
      });
      expect(missingEndDate.status).toBe(400);
      expect(missingEndDate.body.error.code).toBe("VALIDATION_FAILED");

      const endBeforeStart = await scheduleActivity(ctx, owner, {
        requestKey: "val-rep-end-before",
        name: "Weekly check",
        scheduledDate: "2026-11-10",
        scheduledTime: "09:00",
        recurrence: "WEEKLY",
        endDate: "2026-11-09",
      });
      expect(endBeforeStart.status).toBe(400);
      expect(endBeforeStart.body.error.code).toBe("VALIDATION_FAILED");

      for (const badEndDate of ["2026-02-29", "2026-02-30", "2026-04-31"]) {
        const impossibleEnd = await scheduleActivity(ctx, owner, {
          requestKey: `val-rep-bad-end-${badEndDate}`,
          name: "Monthly check",
          scheduledDate: "2026-01-31",
          scheduledTime: "09:00",
          recurrence: "MONTHLY",
          endDate: badEndDate,
        });
        expect(impossibleEnd.status).toBe(400);
        expect(impossibleEnd.body.error.code).toBe("VALIDATION_FAILED");
      }

      const oneTimeWithEndDate = await scheduleActivity(ctx, owner, {
        requestKey: "val-rep-onetime-end",
        name: "One-time with end",
        scheduledDate: "2026-11-10",
        scheduledTime: "09:00",
        recurrence: "ONE_TIME",
        endDate: "2026-11-12",
      });
      expect(oneTimeWithEndDate.status).toBe(400);
      expect(oneTimeWithEndDate.body.error.code).toBe("VALIDATION_FAILED");

      const omittedWithEndDate = await scheduleActivity(ctx, owner, {
        requestKey: "val-rep-omitted-end",
        name: "Omitted recurrence with end",
        scheduledDate: "2026-11-10",
        scheduledTime: "09:00",
        endDate: "2026-11-12",
      });
      expect(omittedWithEndDate.status).toBe(400);
      expect(omittedWithEndDate.body.error.code).toBe("VALIDATION_FAILED");

      const invalidRecurrence = await scheduleActivity(ctx, owner, {
        requestKey: "val-rep-invalid-rule",
        name: "Yearly check",
        scheduledDate: "2026-11-10",
        scheduledTime: "09:00",
        recurrence: "YEARLY",
        endDate: "2027-11-10",
      });
      expect(invalidRecurrence.status).toBe(400);
      expect(invalidRecurrence.body.error.code).toBe("VALIDATION_FAILED");

      const occCount = await ctx.db.query<{ count: string }>("SELECT COUNT(*) AS count FROM calendar_occurrences");
      const serCount = await ctx.db.query<{ count: string }>("SELECT COUNT(*) AS count FROM calendar_series");
      expect(Number(occCount.rows[0]!.count)).toBe(0);
      expect(Number(serCount.rows[0]!.count)).toBe(0);
    });

    it("preserves one-time behavior when recurrence is omitted and enforces same-key retry on a saved series", async () => {
      const oneTime = await scheduleActivity(ctx, owner, {
        requestKey: "onetime-compat-1",
        name: "One-time valve grease",
        scheduledDate: "2026-11-10",
        scheduledTime: "09:30",
      });
      expect(oneTime.status).toBe(201);
      expect(oneTime.body.recurrence).toBe("ONE_TIME");
      expect(oneTime.body.seriesReference).toBeNull();
      expect(oneTime.body.seriesIndex).toBeNull();
      expect(oneTime.body.seriesEndDate).toBeNull();
      expect(oneTime.body.series).toBeNull();
      expect(oneTime.body.activities).toHaveLength(1);
      expect(oneTime.body.reference).toBe(oneTime.body.activity.reference);

      const seriesPayload = {
        requestKey: "rep-retry-1",
        name: "Chlorine residual check",
        scheduledDate: "2026-11-11",
        scheduledTime: "08:00",
        scheduleNotes: "Log test strip reading.",
        recurrence: "DAILY",
        endDate: "2026-11-13",
      };
      const first = await scheduleActivity(ctx, owner, seriesPayload);
      expect(first.status).toBe(201);
      expect(first.body.replayed).toBe(false);
      const firstRefs = first.body.activities.map((a: any) => a.reference);

      const replay = await scheduleActivity(ctx, owner, seriesPayload);
      expect(replay.status).toBe(200);
      expect(replay.body.replayed).toBe(true);
      expect(replay.body.series).toEqual(first.body.series);
      expect(replay.body.activities.map((a: any) => a.reference)).toEqual(firstRefs);

      for (const mutated of [
        { ...seriesPayload, endDate: "2026-11-14" },
        { ...seriesPayload, recurrence: "WEEKLY" },
        { ...seriesPayload, name: "Different name" },
        { ...seriesPayload, scheduledDate: "2026-11-12" },
        { ...seriesPayload, scheduleNotes: "Different note" },
      ]) {
        const conflict = await scheduleActivity(ctx, owner, mutated);
        expect(conflict.status).toBe(409);
        expect(conflict.body.error.code).toBe("REQUEST_KEY_CONFLICT");
      }

      const occCount = await ctx.db.query<{ count: string }>("SELECT COUNT(*) AS count FROM calendar_occurrences");
      const serCount = await ctx.db.query<{ count: string }>("SELECT COUNT(*) AS count FROM calendar_series");
      expect(Number(occCount.rows[0]!.count)).toBe(4);
      expect(Number(serCount.rows[0]!.count)).toBe(1);
    });

    it("detects conflicts across all candidate occurrences, rejects stale acknowledgments, and denies Employee writes", async () => {
      const unfinishedNov11 = await scheduleActivity(ctx, owner, {
        requestKey: "rep-conf-seed-1",
        name: "Existing unfinished Nov 11",
        scheduledDate: "2026-11-11",
        scheduledTime: "10:00",
      });
      expect(unfinishedNov11.status).toBe(201);
      const refNov11 = unfinishedNov11.body.reference as string;

      const completedNov12 = await scheduleActivity(ctx, owner, {
        requestKey: "rep-conf-seed-2",
        name: "Already completed Nov 12",
        scheduledDate: "2026-11-12",
        scheduledTime: "10:00",
      });
      expect(completedNov12.status).toBe(201);
      const doneNov12 = await completeActivity(ctx, owner, completedNov12.body.reference, {
        completedDate: "2026-11-09",
        completedTime: "08:45",
        completionNotes: "Completed early.",
        confirmed: true,
      });
      expect(doneNov12.status).toBe(200);

      // Employee cannot create a repeating schedule.
      const deniedEmployee = await scheduleActivity(ctx, cashier, {
        requestKey: "emp-rep-denied",
        name: "Unauthorized series",
        scheduledDate: "2026-11-10",
        scheduledTime: "10:00",
        recurrence: "DAILY",
        endDate: "2026-11-12",
      });
      expect(deniedEmployee.status).toBe(403);
      expect(deniedEmployee.body.error.code).toBe("FORBIDDEN");

      // Unacknowledged series hits only the unfinished Nov 11 conflict, leaving zero partial series rows.
      const firstAttempt = await scheduleActivity(ctx, owner, {
        requestKey: "rep-conf-series",
        name: "Daily pump check",
        scheduledDate: "2026-11-10",
        scheduledTime: "10:00",
        recurrence: "DAILY",
        endDate: "2026-11-12",
      });
      expect(firstAttempt.status).toBe(409);
      expect(firstAttempt.body.error.code).toBe("SCHEDULE_CONFLICT");
      expect(firstAttempt.body.conflictReferences).toEqual([refNov11]);
      expect(firstAttempt.body.conflictDates).toEqual(["2026-11-11"]);

      let serCount = await ctx.db.query<{ count: string }>("SELECT COUNT(*) AS count FROM calendar_series");
      let occCount = await ctx.db.query<{ count: string }>("SELECT COUNT(*) AS count FROM calendar_occurrences");
      expect(Number(serCount.rows[0]!.count)).toBe(0);
      expect(Number(occCount.rows[0]!.count)).toBe(2);

      // Another unfinished activity appears on Nov 12 10:00 before retry.
      const unfinishedNov12 = await scheduleActivity(ctx, owner, {
        requestKey: "rep-conf-seed-3",
        name: "New unfinished Nov 12",
        scheduledDate: "2026-11-12",
        scheduledTime: "10:00",
        acknowledgedConflictReferences: undefined,
      });
      expect(unfinishedNov12.status).toBe(201);
      const refNov12 = unfinishedNov12.body.reference as string;

      // Retrying with stale acknowledgment [refNov11] fails with updated conflict set.
      const staleRetry = await scheduleActivity(ctx, owner, {
        requestKey: "rep-conf-series",
        name: "Daily pump check",
        scheduledDate: "2026-11-10",
        scheduledTime: "10:00",
        recurrence: "DAILY",
        endDate: "2026-11-12",
        acknowledgedConflictReferences: [refNov11],
      });
      expect(staleRetry.status).toBe(409);
      expect(staleRetry.body.error.code).toBe("SCHEDULE_CONFLICT");
      expect(staleRetry.body.conflictReferences).toEqual([refNov11, refNov12]);
      expect(staleRetry.body.conflictDates).toEqual(["2026-11-11", "2026-11-12"]);

      serCount = await ctx.db.query<{ count: string }>("SELECT COUNT(*) AS count FROM calendar_series");
      occCount = await ctx.db.query<{ count: string }>("SELECT COUNT(*) AS count FROM calendar_occurrences");
      expect(Number(serCount.rows[0]!.count)).toBe(0);
      expect(Number(occCount.rows[0]!.count)).toBe(3);

      // Confirming both current conflicts creates all 3 occurrences in one series.
      const confirmed = await scheduleActivity(ctx, owner, {
        requestKey: "rep-conf-series",
        name: "Daily pump check",
        scheduledDate: "2026-11-10",
        scheduledTime: "10:00",
        recurrence: "DAILY",
        endDate: "2026-11-12",
        acknowledgedConflictReferences: [refNov11, refNov12],
      });
      expect(confirmed.status).toBe(201);
      expect(confirmed.body.activities).toHaveLength(3);
      expect(confirmed.body.activities.map((a: any) => a.scheduledDate)).toEqual([
        "2026-11-10",
        "2026-11-11",
        "2026-11-12",
      ]);

      // Retrying with the same requestKey after save replays without needing conflict confirmation.
      const postSaveReplay = await scheduleActivity(ctx, owner, {
        requestKey: "rep-conf-series",
        name: "Daily pump check",
        scheduledDate: "2026-11-10",
        scheduledTime: "10:00",
        recurrence: "DAILY",
        endDate: "2026-11-12",
      });
      expect(postSaveReplay.status).toBe(200);
      expect(postSaveReplay.body.replayed).toBe(true);
      expect(postSaveReplay.body.series).toEqual(confirmed.body.series);
    });

    it("enforces the 1,096-occurrence repeat limit and batches reference allocation, replay, and conflicts at max capacity", async () => {
      // 2026-11-09 through 2029-11-09 inclusive is 1,097 daily occurrences -> rejected with 400.
      const overLimit = await scheduleActivity(ctx, owner, {
        requestKey: "rep-limit-1097",
        name: "Over-limit daily check",
        scheduledDate: "2026-11-09",
        scheduledTime: "08:00",
        recurrence: "DAILY",
        endDate: "2029-11-09",
      });
      expect(overLimit.status).toBe(400);
      expect(overLimit.body.error.code).toBe("VALIDATION_FAILED");
      expect(overLimit.body.error.message).toContain("1,096");
      expect(overLimit.body.error.message).toContain("earlier end date");

      let serCount = await ctx.db.query<{ count: string }>("SELECT COUNT(*) AS count FROM calendar_series");
      let occCount = await ctx.db.query<{ count: string }>("SELECT COUNT(*) AS count FROM calendar_occurrences");
      expect(Number(serCount.rows[0]!.count)).toBe(0);
      expect(Number(occCount.rows[0]!.count)).toBe(0);

      // 2026-11-09 through 2029-11-08 inclusive is exactly 1,096 daily occurrences (includes 2028 leap day).
      const atLimit = await scheduleActivity(ctx, owner, {
        requestKey: "rep-limit-1096",
        name: "Three-year daily check",
        scheduledDate: "2026-11-09",
        scheduledTime: "08:00",
        recurrence: "DAILY",
        endDate: "2029-11-08",
      });
      expect(atLimit.status).toBe(201);
      expect(atLimit.body.replayed).toBe(false);
      expect(atLimit.body.series.occurrenceCount).toBe(1096);
      expect(atLimit.body.activities).toHaveLength(1096);
      expect(atLimit.body.activities[0]).toMatchObject({
        reference: "ACT-1109-01",
        scheduledDate: "2026-11-09",
        seriesIndex: 1,
      });
      expect(atLimit.body.activities[365]).toMatchObject({
        reference: "ACT-1109-02",
        scheduledDate: "2027-11-09",
        seriesIndex: 366,
      });
      expect(atLimit.body.activities[731]).toMatchObject({
        reference: "ACT-1109-03",
        scheduledDate: "2028-11-09",
        seriesIndex: 732,
      });
      expect(atLimit.body.activities[1095]).toMatchObject({
        scheduledDate: "2029-11-08",
        seriesIndex: 1096,
      });

      const leapDayEntry = atLimit.body.activities.find((a: any) => a.scheduledDate === "2028-02-29");
      expect(leapDayEntry).toBeDefined();

      // Same-key replay preserves all 1,096 references without duplicates.
      const replayed = await scheduleActivity(ctx, owner, {
        requestKey: "rep-limit-1096",
        name: "Three-year daily check",
        scheduledDate: "2026-11-09",
        scheduledTime: "08:00",
        recurrence: "DAILY",
        endDate: "2029-11-08",
      });
      expect(replayed.status).toBe(200);
      expect(replayed.body.replayed).toBe(true);
      expect(replayed.body.series.occurrenceReferences).toEqual(atLimit.body.series.occurrenceReferences);

      serCount = await ctx.db.query<{ count: string }>("SELECT COUNT(*) AS count FROM calendar_series");
      occCount = await ctx.db.query<{ count: string }>("SELECT COUNT(*) AS count FROM calendar_occurrences");
      expect(Number(serCount.rows[0]!.count)).toBe(1);
      expect(Number(occCount.rows[0]!.count)).toBe(1096);

      // Same-time conflict check sees the batched 2028-02-29 occurrence.
      const leapConflict = await scheduleActivity(ctx, owner, {
        requestKey: "rep-limit-conflict",
        name: "Leap day check",
        scheduledDate: "2028-02-29",
        scheduledTime: "08:00",
      });
      expect(leapConflict.status).toBe(409);
      expect(leapConflict.body.error.code).toBe("SCHEDULE_CONFLICT");
      expect(leapConflict.body.conflictReferences).toEqual([leapDayEntry.reference]);
      expect(leapConflict.body.conflictDates).toEqual(["2028-02-29"]);
    });
  });

  describe("edit, reschedule, and cancel with history (Task 2)", () => {
    it("moves overdue Monday filter replacement to Wednesday under one reference while preserving Tuesday overdue and completed entries", async () => {
      // Seed Daily Mon Nov 9 .. Fri Nov 13 at 09:00 while clock is 2026-11-09 09:00.
      const series = await scheduleActivity(ctx, owner, {
        requestKey: "t2-mon-seed",
        name: "Filter replacement",
        scheduledDate: "2026-11-09",
        scheduledTime: "09:00",
        scheduleNotes: "Replace carbon pre-filter.",
        recurrence: "DAILY",
        endDate: "2026-11-13",
      });
      expect(series.status).toBe(201);
      const [mon, tue, wed, thu, fri] = series.body.activities as Array<any>;

      // Complete Fri Nov 13 early and cancel Wed Nov 11? Keep Wed completed or move Mon to Wed 14:00.
      const friDone = await completeActivity(ctx, owner, fri.reference, {
        completedDate: "2026-11-09",
        completedTime: "08:50",
        completionNotes: "Replaced early.",
        confirmed: true,
      });
      expect(friDone.status).toBe(200);

      // Advance clock to Wednesday 2026-11-11 09:30+08:00 so Mon & Tue are overdue.
      ctx.clock.set("2026-11-11T09:30:00+08:00");
      owner = await reauth(ctx, "owner1", owner);
      cashier = await reauth(ctx, "cashier1", cashier);

      const moveRes = await patchActivity(ctx, owner, mon.reference, {
        requestKey: "t2-move-mon-wed",
        expectedVersion: mon.version,
        scope: "THIS_OCCURRENCE",
        scheduledDate: "2026-11-11",
        scheduledTime: "14:00",
        scheduleNotes: "Moved Monday replacement to Wednesday afternoon.",
      });
      expect(moveRes.status).toBe(200);
      expect(moveRes.body.replayed).toBe(false);
      expect(moveRes.body.reference).toBe(mon.reference);
      expect(moveRes.body.version).toBe(2);
      expect(moveRes.body.scheduledDate).toBe("2026-11-11");
      expect(moveRes.body.scheduledTime).toBe("14:00");
      expect(moveRes.body.scheduleNotes).toBe("Moved Monday replacement to Wednesday afternoon.");
      expect(moveRes.body.originalScheduledDate).toBe("2026-11-09");
      expect(moveRes.body.originalScheduledTime).toBe("09:00");
      expect(moveRes.body.originalScheduleNotes).toBe("Replace carbon pre-filter.");
      expect(moveRes.body.status).toBe("SCHEDULED");
      expect(moveRes.body.scheduleHistory).toHaveLength(1);
      expect(moveRes.body.scheduleHistory[0]).toMatchObject({
        changeType: "EDIT",
        scope: "THIS_OCCURRENCE",
        previousScheduledDate: "2026-11-09",
        previousScheduledTime: "09:00",
        newScheduledDate: "2026-11-11",
        newScheduledTime: "14:00",
        changedBy: "owner1",
        changedAt: "2026-11-11T09:30:00+08:00",
      });

      // Tuesday overdue and Friday completed remain untouched.
      const tueDetail = await request(ctx.app)
        .get(`/api/calendar/activities/${tue.reference}`)
        .set("Cookie", cashier.cookie);
      expect(tueDetail.status).toBe(200);
      expect(tueDetail.body.status).toBe("OVERDUE");
      expect(tueDetail.body.scheduledDate).toBe("2026-11-10");
      expect(tueDetail.body.version).toBe(1);
      expect(tueDetail.body.scheduleHistory).toEqual([]);

      const friDetail = await request(ctx.app)
        .get(`/api/calendar/activities/${fri.reference}`)
        .set("Cookie", cashier.cookie);
      expect(friDetail.status).toBe(200);
      expect(friDetail.body.status).toBe("COMPLETED");
      expect(friDetail.body.scheduledDate).toBe("2026-11-13");

      // Same-key replay returns the existing updated result; mismatched payload returns 409 REQUEST_KEY_CONFLICT.
      const replay = await patchActivity(ctx, owner, mon.reference, {
        requestKey: "t2-move-mon-wed",
        expectedVersion: mon.version,
        scope: "THIS_OCCURRENCE",
        scheduledDate: "2026-11-11",
        scheduledTime: "14:00",
        scheduleNotes: "Moved Monday replacement to Wednesday afternoon.",
      });
      expect(replay.status).toBe(200);
      expect(replay.body.replayed).toBe(true);
      expect(replay.body.reference).toBe(mon.reference);
      expect(replay.body.version).toBe(2);

      const keyConflict = await patchActivity(ctx, owner, mon.reference, {
        requestKey: "t2-move-mon-wed",
        expectedVersion: mon.version,
        scope: "THIS_OCCURRENCE",
        scheduledDate: "2026-11-11",
        scheduledTime: "16:00",
      });
      expect(keyConflict.status).toBe(409);
      expect(keyConflict.body.error.code).toBe("REQUEST_KEY_CONFLICT");
      expect(wed.reference).toBeDefined();
      expect(thu.reference).toBeDefined();
    });

    it("applies THIS_AND_FUTURE edits only to selected entry and later upcoming unfinished entries, preserving other overdue and completed entries", async () => {
      const series = await scheduleActivity(ctx, owner, {
        requestKey: "t2-bulk-edit-seed",
        name: "Sanitize storage tank",
        scheduledDate: "2026-11-09",
        scheduledTime: "09:00",
        recurrence: "DAILY",
        endDate: "2026-11-14",
      });
      expect(series.status).toBe(201);
      // Mon(9), Tue(10), Wed(11), Thu(12), Fri(13), Sat(14)
      const [mon, tue, wed, thu, fri, sat] = series.body.activities as Array<any>;

      // Complete Fri Nov 13 early, and cancel Wed Nov 11? Wait: let's complete Fri Nov 13 early.
      const friDone = await completeActivity(ctx, owner, fri.reference, {
        completedDate: "2026-11-09",
        completedTime: "08:30",
        completionNotes: "Completed early.",
        confirmed: true,
      });
      expect(friDone.status).toBe(200);

      // Move clock to Wed 2026-11-11 10:00 -> Mon(9), Tue(10), Wed(11) are overdue; Thu(12) & Sat(14) are upcoming unfinished; Fri(13) is completed.
      ctx.clock.set("2026-11-11T10:00:00+08:00");
      owner = await reauth(ctx, "owner1", owner);

      const preview = await patchActivity(ctx, owner, mon.reference, {
        preview: true,
        expectedVersion: mon.version,
        scope: "THIS_AND_FUTURE",
        scheduledDate: "2026-11-11",
        scheduledTime: "15:00",
        name: "Sanitize main tank",
      });
      expect(preview.status).toBe(200);
      expect(preview.body.preview).toBe(true);
      expect(preview.body.affectedReferences).toEqual([mon.reference, thu.reference, sat.reference]);
      expect(preview.body.affectedVersions).toEqual({
        [mon.reference]: 1,
        [thu.reference]: 1,
        [sat.reference]: 1,
      });
      expect(preview.body.protectedActivities.map((a: any) => a.reference)).toEqual([
        tue.reference,
        wed.reference,
        fri.reference,
      ]);

      const saveBulk = await patchActivity(ctx, owner, mon.reference, {
        requestKey: "t2-bulk-edit-save",
        expectedVersion: mon.version,
        scope: "THIS_AND_FUTURE",
        scheduledDate: "2026-11-11",
        scheduledTime: "15:00",
        name: "Sanitize main tank",
        expectedAffectedReferences: preview.body.affectedReferences,
        expectedAffectedVersions: preview.body.affectedVersions,
      });
      expect(saveBulk.status).toBe(200);
      expect(saveBulk.body.affectedReferences).toEqual([mon.reference, thu.reference, sat.reference]);
      expect(saveBulk.body.activities.map((a: any) => [a.reference, a.scheduledDate, a.scheduledTime, a.originalScheduledDate])).toEqual([
        [mon.reference, "2026-11-11", "15:00", "2026-11-09"],
        [thu.reference, "2026-11-14", "15:00", "2026-11-12"],
        [sat.reference, "2026-11-16", "15:00", "2026-11-14"],
      ]);

      // Other overdue (Tue, Wed) and completed (Fri) stay untouched.
      for (const untouched of [tue, wed]) {
        const res = await request(ctx.app).get(`/api/calendar/activities/${untouched.reference}`).set("Cookie", owner.cookie);
        expect(res.body.name).toBe("Sanitize storage tank");
        expect(res.body.status).toBe("OVERDUE");
        expect(res.body.version).toBe(1);
      }
      const friAfter = await request(ctx.app).get(`/api/calendar/activities/${fri.reference}`).set("Cookie", owner.cookie);
      expect(friAfter.body.name).toBe("Sanitize storage tank");
      expect(friAfter.body.status).toBe("COMPLETED");

      // Non-repeating entry rejects nothing and stays single-occurrence.
      const single = await scheduleActivity(ctx, owner, {
        requestKey: "t2-single-edit-seed",
        name: "One-time valve check",
        scheduledDate: "2026-11-12",
        scheduledTime: "11:00",
      });
      const singleEdit = await patchActivity(ctx, owner, single.body.reference, {
        requestKey: "t2-single-edit",
        expectedVersion: 1,
        scope: "THIS_AND_FUTURE",
        scheduledDate: "2026-11-13",
        scheduledTime: "11:30",
      });
      expect(singleEdit.status).toBe(200);
      expect(singleEdit.body.affectedReferences).toEqual([single.body.reference]);
      expect(singleEdit.body.scheduledDate).toBe("2026-11-13");
    });

    it("enforces cancellation reason, Employee 403, bulk cancellation cutoff, Cancelled list access, and conflict exclusion", async () => {
      const series = await scheduleActivity(ctx, owner, {
        requestKey: "t2-cancel-seed",
        name: "Flush reverse osmosis",
        scheduledDate: "2026-11-09",
        scheduledTime: "10:00",
        recurrence: "DAILY",
        endDate: "2026-11-13",
      });
      expect(series.status).toBe(201);
      const [mon, tue, wed, thu, fri] = series.body.activities as Array<any>;

      const thuDone = await completeActivity(ctx, owner, thu.reference, {
        completedDate: "2026-11-09",
        completedTime: "08:55",
        completionNotes: "Early flush done.",
        confirmed: true,
      });
      expect(thuDone.status).toBe(200);

      // Clock at Wed Nov 11 11:00 -> Mon(9), Tue(10), Wed(11) are overdue; Thu(12) completed; Fri(13) upcoming.
      ctx.clock.set("2026-11-11T11:00:00+08:00");
      owner = await reauth(ctx, "owner1", owner);
      cashier = await reauth(ctx, "cashier1", cashier);

      // Employee cannot edit or cancel.
      const empPatch = await patchActivity(ctx, cashier, mon.reference, {
        requestKey: "t2-emp-patch",
        expectedVersion: 1,
        scope: "THIS_OCCURRENCE",
        scheduledDate: "2026-11-12",
        scheduledTime: "10:00",
      });
      expect(empPatch.status).toBe(403);

      const empCancel = await cancelActivity(ctx, cashier, mon.reference, {
        requestKey: "t2-emp-cancel",
        expectedVersion: 1,
        scope: "THIS_OCCURRENCE",
        reason: "Not allowed",
      });
      expect(empCancel.status).toBe(403);

      // Blank reason rejected.
      const blankReason = await cancelActivity(ctx, owner, mon.reference, {
        requestKey: "t2-blank-cancel",
        expectedVersion: 1,
        scope: "THIS_OCCURRENCE",
        reason: "   ",
      });
      expect(blankReason.status).toBe(400);
      expect(blankReason.body.error.code).toBe("VALIDATION_FAILED");

      // Bulk cancel Mon with THIS_AND_FUTURE -> cancels Mon and Fri only; Tue/Wed overdue and Thu completed remain intact.
      const bulkCancelPreview = await cancelActivity(ctx, owner, mon.reference, {
        preview: true,
        expectedVersion: 1,
        scope: "THIS_AND_FUTURE",
      });
      expect(bulkCancelPreview.status).toBe(200);
      expect(bulkCancelPreview.body.affectedReferences).toEqual([mon.reference, fri.reference]);
      expect(bulkCancelPreview.body.affectedVersions).toEqual({
        [mon.reference]: 1,
        [fri.reference]: 1,
      });

      const bulkCancel = await cancelActivity(ctx, owner, mon.reference, {
        requestKey: "t2-bulk-cancel",
        expectedVersion: 1,
        scope: "THIS_AND_FUTURE",
        reason: "Station closed for maintenance",
        expectedAffectedReferences: bulkCancelPreview.body.affectedReferences,
        expectedAffectedVersions: bulkCancelPreview.body.affectedVersions,
      });
      expect(bulkCancel.status).toBe(200);
      expect(bulkCancel.body.affectedReferences).toEqual([mon.reference, fri.reference]);
      expect(bulkCancel.body.status).toBe("CANCELLED");
      expect(bulkCancel.body.cancellation).toEqual({
        reason: "Station closed for maintenance",
        cancelledBy: "owner1",
        cancelledAt: "2026-11-11T11:00:00+08:00",
      });

      // Both Owner and Employee see cancelled entries in cancelledActivities, excluded from scheduledActivities & reminders.
      const empMonth = await request(ctx.app)
        .get("/api/calendar/activities?month=2026-11")
        .set("Cookie", cashier.cookie);
      expect(empMonth.status).toBe(200);
      expect(empMonth.body.scheduledActivities.map((a: any) => a.reference)).toEqual([
        tue.reference,
        wed.reference,
        thu.reference,
      ]);
      expect(empMonth.body.completedActivities.map((a: any) => a.reference)).toEqual([thu.reference]);
      expect(empMonth.body.cancelledActivities.map((a: any) => a.reference)).toEqual([
        mon.reference,
        fri.reference,
      ]);
      expect(empMonth.body.cancelledActivities[0].cancellation.reason).toBe("Station closed for maintenance");

      const reminders = await request(ctx.app).get("/api/calendar/reminders").set("Cookie", cashier.cookie);
      expect(reminders.status).toBe(200);
      expect(reminders.body.items.map((i: any) => i.reference)).toEqual([tue.reference, wed.reference]);

      // Cancelled occurrence does not cause a same-time conflict, and cannot be edited/completed/cancelled again.
      const reuseTime = await scheduleActivity(ctx, owner, {
        requestKey: "t2-reuse-cancelled-slot",
        name: "Replacement task at cancelled time",
        scheduledDate: "2026-11-13",
        scheduledTime: "10:00",
      });
      expect(reuseTime.status).toBe(201);

      const editCancelled = await patchActivity(ctx, owner, mon.reference, {
        requestKey: "t2-edit-cancelled",
        expectedVersion: 2,
        scope: "THIS_OCCURRENCE",
        scheduledDate: "2026-11-14",
        scheduledTime: "10:00",
      });
      expect(editCancelled.status).toBe(409);
      expect(editCancelled.body.error.code).toBe("ACTIVITY_ALREADY_CANCELLED");

      const completeCancelled = await completeActivity(ctx, owner, mon.reference, {
        completedDate: "2026-11-11",
        completedTime: "10:30",
        completionNotes: "Should fail.",
        confirmed: true,
      });
      expect(completeCancelled.status).toBe(409);
      expect(completeCancelled.body.error.code).toBe("ACTIVITY_ALREADY_CANCELLED");
    });

    it("recalculates conflicts inside the save transaction and rejects stale scopes, stale versions, and competing writes", async () => {
      const series = await scheduleActivity(ctx, owner, {
        requestKey: "t2-race-series",
        name: "Pump gauge check",
        scheduledDate: "2026-11-10",
        scheduledTime: "09:00",
        recurrence: "DAILY",
        endDate: "2026-11-12",
      });
      const [day1, day2, day3] = series.body.activities as Array<any>;

      // Preview moving day1 to 2026-11-15 11:00 -> clean preview.
      const cleanPreview = await patchActivity(ctx, owner, day1.reference, {
        preview: true,
        expectedVersion: 1,
        scope: "THIS_OCCURRENCE",
        scheduledDate: "2026-11-15",
        scheduledTime: "11:00",
      });
      expect(cleanPreview.status).toBe(200);
      expect(cleanPreview.body.conflictReferences).toEqual([]);

      // Another unfinished activity appears at 2026-11-15 11:00 before save.
      const blocker = await scheduleActivity(ctx, owner, {
        requestKey: "t2-new-blocker",
        name: "Competing task",
        scheduledDate: "2026-11-15",
        scheduledTime: "11:00",
      });
      expect(blocker.status).toBe(201);

      const conflictSave = await patchActivity(ctx, owner, day1.reference, {
        requestKey: "t2-conflict-save-1",
        expectedVersion: 1,
        scope: "THIS_OCCURRENCE",
        scheduledDate: "2026-11-15",
        scheduledTime: "11:00",
      });
      expect(conflictSave.status).toBe(409);
      expect(conflictSave.body.error.code).toBe("SCHEDULE_CONFLICT");
      expect(conflictSave.body.conflictReferences).toEqual([blocker.body.reference]);
      expect(conflictSave.body.conflictDates).toEqual(["2026-11-15"]);

      // Now blocker is cancelled, so saving without conflict acknowledgment succeeds cleanly!
      const cancelBlocker = await cancelActivity(ctx, owner, blocker.body.reference, {
        requestKey: "t2-cancel-blocker",
        expectedVersion: 1,
        scope: "THIS_OCCURRENCE",
        reason: "No longer needed",
      });
      expect(cancelBlocker.status).toBe(200);

      const resolvedSave = await patchActivity(ctx, owner, day1.reference, {
        requestKey: "t2-conflict-save-2",
        expectedVersion: 1,
        scope: "THIS_OCCURRENCE",
        scheduledDate: "2026-11-15",
        scheduledTime: "11:00",
      });
      expect(resolvedSave.status).toBe(200);
      expect(resolvedSave.body.scheduledDate).toBe("2026-11-15");

      // Stale scope: preview THIS_AND_FUTURE on day2 -> [day2, day3], then day3 completes before save.
      const bulkPreview = await patchActivity(ctx, owner, day2.reference, {
        preview: true,
        expectedVersion: 1,
        scope: "THIS_AND_FUTURE",
        scheduledDate: "2026-11-16",
        scheduledTime: "09:00",
      });
      expect(bulkPreview.body.affectedReferences).toEqual([day2.reference, day3.reference]);

      const completeDay3 = await completeActivity(ctx, owner, day3.reference, {
        completedDate: "2026-11-09",
        completedTime: "08:50",
        completionNotes: "Completed before bulk edit.",
        confirmed: true,
      });
      expect(completeDay3.status).toBe(200);

      const staleScope = await patchActivity(ctx, owner, day2.reference, {
        requestKey: "t2-stale-scope",
        expectedVersion: 1,
        scope: "THIS_AND_FUTURE",
        scheduledDate: "2026-11-16",
        scheduledTime: "09:00",
        expectedAffectedReferences: bulkPreview.body.affectedReferences,
        expectedAffectedVersions: bulkPreview.body.affectedVersions,
      });
      expect(staleScope.status).toBe(409);
      expect(staleScope.body.error.code).toBe("STALE_SCOPE");
      expect(staleScope.body.affectedReferences).toEqual([day2.reference]);

      // Concurrent edit vs completion on day2: one succeeds, the other gets 409.
      const [editRace, completeRace] = await Promise.all([
        patchActivity(ctx, owner, day2.reference, {
          requestKey: "t2-race-edit",
          expectedVersion: 1,
          scope: "THIS_OCCURRENCE",
          scheduledDate: "2026-11-17",
          scheduledTime: "09:00",
        }),
        completeActivity(ctx, owner, day2.reference, {
          expectedVersion: 1,
          completedDate: "2026-11-09",
          completedTime: "08:55",
          completionNotes: "Concurrent completion.",
          confirmed: true,
        }),
      ]);
      const raceStatuses = [editRace.status, completeRace.status].sort((a, b) => a - b);
      expect(raceStatuses).toEqual([200, 409]);

      // Concurrent cancellation vs completion on a fresh activity: one succeeds, the other gets 409.
      const cancelRaceSeed = await scheduleActivity(ctx, owner, {
        requestKey: "t2-cancel-race-seed",
        name: "Cancel vs complete race",
        scheduledDate: "2026-11-18",
        scheduledTime: "09:00",
      });
      const cancelRaceRef = cancelRaceSeed.body.reference as string;
      const [cancelRace, compCancelRace] = await Promise.all([
        cancelActivity(ctx, owner, cancelRaceRef, {
          requestKey: "t2-race-cancel",
          expectedVersion: 1,
          scope: "THIS_OCCURRENCE",
          reason: "Cancelled concurrently",
        }),
        completeActivity(ctx, owner, cancelRaceRef, {
          completedDate: "2026-11-09",
          completedTime: "08:55",
          completionNotes: "Completed concurrently.",
          confirmed: true,
        }),
      ]);
      expect([cancelRace.status, compCancelRace.status].sort((a, b) => a - b)).toEqual([200, 409]);
    });

    it("updates Calendar reminders and Dashboard overdue recommendation across reschedule and cancellation", async () => {
      const created = await scheduleActivity(ctx, owner, {
        requestKey: "t2-rem-seed",
        name: "Overdue pump calibration",
        scheduledDate: "2026-11-09",
        scheduledTime: "08:00",
      });
      expect(created.status).toBe(201);
      const ref = created.body.reference as string;

      // At 2026-11-09 09:00, 08:00 is overdue in Calendar reminders and Dashboard.
      const remOverdue = await request(ctx.app).get("/api/calendar/reminders").set("Cookie", cashier.cookie);
      expect(remOverdue.body.overdueCount).toBe(1);
      expect(remOverdue.body.upcomingCount).toBe(0);

      const dashOverdue = await request(ctx.app)
        .get("/api/dashboard/sales?period=TODAY")
        .set("Cookie", owner.cookie);
      expect(dashOverdue.status).toBe(200);
      expect(dashOverdue.body.recommendations.some((r: any) => r.type === "OVERDUE_ACTIVITIES")).toBe(true);

      // Reschedule 10 days ahead (2026-11-19) -> outside 7-day window (now..Nov 15 23:59).
      const moveFar = await patchActivity(ctx, owner, ref, {
        requestKey: "t2-rem-far",
        expectedVersion: 1,
        scope: "THIS_OCCURRENCE",
        scheduledDate: "2026-11-19",
        scheduledTime: "10:00",
      });
      expect(moveFar.status).toBe(200);

      const remFar = await request(ctx.app).get("/api/calendar/reminders").set("Cookie", cashier.cookie);
      expect(remFar.body).toEqual({ upcomingCount: 0, overdueCount: 0, items: [] });

      const dashFar = await request(ctx.app)
        .get("/api/dashboard/sales?period=TODAY")
        .set("Cookie", owner.cookie);
      expect(dashFar.status).toBe(200);
      expect(dashFar.body.recommendations.some((r: any) => r.type === "OVERDUE_ACTIVITIES")).toBe(false);

      // Move inside 7-day window (2026-11-12) -> appears as UPCOMING.
      const moveNear = await patchActivity(ctx, owner, ref, {
        requestKey: "t2-rem-near",
        expectedVersion: 2,
        scope: "THIS_OCCURRENCE",
        scheduledDate: "2026-11-12",
        scheduledTime: "10:00",
      });
      expect(moveNear.status).toBe(200);

      const remNear = await request(ctx.app).get("/api/calendar/reminders").set("Cookie", cashier.cookie);
      expect(remNear.body.upcomingCount).toBe(1);
      expect(remNear.body.overdueCount).toBe(0);
      expect(remNear.body.items[0]).toMatchObject({ reference: ref, status: "UPCOMING", scheduledDate: "2026-11-12" });

      // Cancel -> leaves reminders immediately.
      const cancelRes = await cancelActivity(ctx, owner, ref, {
        requestKey: "t2-rem-cancel",
        expectedVersion: 3,
        scope: "THIS_OCCURRENCE",
        reason: "Replaced by annual service",
      });
      expect(cancelRes.status).toBe(200);

      const remAfterCancel = await request(ctx.app).get("/api/calendar/reminders").set("Cookie", cashier.cookie);
      expect(remAfterCancel.body).toEqual({ upcomingCount: 0, overdueCount: 0, items: [] });
    });

    it("preserves monthly preferred-day pattern across shorter months and cutoff on bulk edit (Finding 1)", async () => {
      const monthly = await scheduleActivity(ctx, owner, {
        requestKey: "t2-monthly-pattern-1",
        name: "Monthly membrane sanitize",
        scheduledDate: "2027-01-31",
        scheduledTime: "09:00",
        recurrence: "MONTHLY",
        endDate: "2027-04-30",
      });
      expect(monthly.status).toBe(201);
      const [jan, feb, mar, apr] = monthly.body.activities as Array<any>;

      const preview1 = await patchActivity(ctx, owner, jan.reference, {
        preview: true,
        expectedVersion: 1,
        scope: "THIS_AND_FUTURE",
        scheduledDate: "2027-01-30",
        scheduledTime: "09:00",
      });
      expect(preview1.status).toBe(200);
      expect(preview1.body.affectedReferences).toEqual([jan.reference, feb.reference, mar.reference, apr.reference]);

      const moveTo30th = await patchActivity(ctx, owner, jan.reference, {
        requestKey: "t2-monthly-to-30",
        expectedVersion: 1,
        scope: "THIS_AND_FUTURE",
        scheduledDate: "2027-01-30",
        scheduledTime: "09:00",
        expectedAffectedReferences: preview1.body.affectedReferences,
        expectedAffectedVersions: preview1.body.affectedVersions,
      });
      expect(moveTo30th.status).toBe(200);
      expect(moveTo30th.body.activities.map((a: any) => [a.reference, a.scheduledDate, a.originalScheduledDate])).toEqual([
        [jan.reference, "2027-01-30", "2027-01-31"],
        [feb.reference, "2027-02-28", "2027-02-28"],
        [mar.reference, "2027-03-30", "2027-03-31"],
        [apr.reference, "2027-04-30", "2027-04-30"],
      ]);

      // Cutoff + short month: seed a second monthly series Jan..May 2027, complete Apr early, advance clock to 2027-03-01
      // so Feb is protected overdue and Apr is protected completed; moving Jan to the 30th updates Jan, Mar, May only.
      const series2 = await scheduleActivity(ctx, owner, {
        requestKey: "t2-monthly-pattern-2",
        name: "Monthly tank deep clean",
        scheduledDate: "2027-01-31",
        scheduledTime: "14:00",
        recurrence: "MONTHLY",
        endDate: "2027-05-31",
      });
      expect(series2.status).toBe(201);
      const [sJan, sFeb, sMar, sApr, sMay] = series2.body.activities as Array<any>;

      const aprDone = await completeActivity(ctx, owner, sApr.reference, {
        completedDate: "2026-11-09",
        completedTime: "08:40",
        completionNotes: "Completed early.",
        confirmed: true,
      });
      expect(aprDone.status).toBe(200);

      ctx.clock.set("2027-03-01T09:00:00+08:00");
      owner = await reauth(ctx, "owner1", owner);

      const preview2 = await patchActivity(ctx, owner, sJan.reference, {
        preview: true,
        expectedVersion: 1,
        scope: "THIS_AND_FUTURE",
        scheduledDate: "2027-01-30",
        scheduledTime: "14:00",
      });
      expect(preview2.status).toBe(200);
      expect(preview2.body.affectedReferences).toEqual([sJan.reference, sMar.reference, sMay.reference]);
      expect(preview2.body.protectedActivities.map((a: any) => a.reference)).toEqual([
        sFeb.reference,
        sApr.reference,
      ]);

      const save2 = await patchActivity(ctx, owner, sJan.reference, {
        requestKey: "t2-monthly-cutoff-save",
        expectedVersion: 1,
        scope: "THIS_AND_FUTURE",
        scheduledDate: "2027-01-30",
        scheduledTime: "14:00",
        expectedAffectedReferences: preview2.body.affectedReferences,
        expectedAffectedVersions: preview2.body.affectedVersions,
      });
      expect(save2.status).toBe(200);
      expect(save2.body.activities.map((a: any) => [a.reference, a.scheduledDate, a.originalScheduledDate])).toEqual([
        [sJan.reference, "2027-01-30", "2027-01-31"],
        [sMar.reference, "2027-03-30", "2027-03-31"],
        [sMay.reference, "2027-05-30", "2027-05-31"],
      ]);

      const febAfter = await request(ctx.app).get(`/api/calendar/activities/${sFeb.reference}`).set("Cookie", owner.cookie);
      expect(febAfter.body.status).toBe("OVERDUE");
      expect(febAfter.body.scheduledDate).toBe("2027-02-28");
      const aprAfter = await request(ctx.app).get(`/api/calendar/activities/${sApr.reference}`).set("Cookie", owner.cookie);
      expect(aprAfter.body.status).toBe("COMPLETED");
      expect(aprAfter.body.scheduledDate).toBe("2027-04-30");

      // Time-only edit from clamped Feb 28 (both omitted scheduledDate and resubmitted Feb 28) preserves Mar 31 / Apr 30.
      ctx.clock.set("2026-11-09T09:00:00+08:00");
      owner = await reauth(ctx, "owner1", owner);
      const series3 = await scheduleActivity(ctx, owner, {
        requestKey: "t2-monthly-time-only-seed",
        name: "Monthly 31st time-only test",
        scheduledDate: "2027-01-31",
        scheduledTime: "07:00",
        recurrence: "MONTHLY",
        endDate: "2027-04-30",
      });
      expect(series3.status).toBe(201);
      const [, tFeb, tMar, tApr] = series3.body.activities as Array<any>;

      const timeOnlyOmitDatePreview = await patchActivity(ctx, owner, tFeb.reference, {
        preview: true,
        expectedVersion: 1,
        scope: "THIS_AND_FUTURE",
        scheduledTime: "11:30",
      });
      expect(timeOnlyOmitDatePreview.status).toBe(200);
      expect(timeOnlyOmitDatePreview.body.affectedReferences).toEqual([
        tFeb.reference,
        tMar.reference,
        tApr.reference,
      ]);

      const timeOnlyOmitDateSave = await patchActivity(ctx, owner, tFeb.reference, {
        requestKey: "t2-monthly-time-only-omit-date",
        expectedVersion: 1,
        scope: "THIS_AND_FUTURE",
        scheduledTime: "11:30",
        expectedAffectedReferences: timeOnlyOmitDatePreview.body.affectedReferences,
        expectedAffectedVersions: timeOnlyOmitDatePreview.body.affectedVersions,
      });
      expect(timeOnlyOmitDateSave.status).toBe(200);
      expect(
        timeOnlyOmitDateSave.body.activities.map((a: any) => [a.reference, a.scheduledDate, a.scheduledTime]),
      ).toEqual([
        [tFeb.reference, "2027-02-28", "11:30"],
        [tMar.reference, "2027-03-31", "11:30"],
        [tApr.reference, "2027-04-30", "11:30"],
      ]);

      const timeOnlySameDatePreview = await patchActivity(ctx, owner, tFeb.reference, {
        preview: true,
        expectedVersion: 2,
        scope: "THIS_AND_FUTURE",
        scheduledDate: "2027-02-28",
        scheduledTime: "15:45",
      });
      expect(timeOnlySameDatePreview.status).toBe(200);

      const timeOnlySameDateSave = await patchActivity(ctx, owner, tFeb.reference, {
        requestKey: "t2-monthly-time-only-same-date",
        expectedVersion: 2,
        scope: "THIS_AND_FUTURE",
        scheduledDate: "2027-02-28",
        scheduledTime: "15:45",
        expectedAffectedReferences: timeOnlySameDatePreview.body.affectedReferences,
        expectedAffectedVersions: timeOnlySameDatePreview.body.affectedVersions,
      });
      expect(timeOnlySameDateSave.status).toBe(200);
      expect(
        timeOnlySameDateSave.body.activities.map((a: any) => [a.reference, a.scheduledDate, a.scheduledTime]),
      ).toEqual([
        [tFeb.reference, "2027-02-28", "15:45"],
        [tMar.reference, "2027-03-31", "15:45"],
        [tApr.reference, "2027-04-30", "15:45"],
      ]);
    });

    it("requires a complete and current preview before saving bulk edit or cancellation while preserving replay (Finding 2)", async () => {
      const series = await scheduleActivity(ctx, owner, {
        requestKey: "t2-f2-seed",
        name: "Daily filter flush",
        scheduledDate: "2026-11-10",
        scheduledTime: "09:00",
        recurrence: "DAILY",
        endDate: "2026-11-12",
      });
      expect(series.status).toBe(201);
      const [first, second, third] = series.body.activities as Array<any>;

      // Missing preview scope/versions rejected with 400 on both bulk edit and bulk cancel.
      const missingEditPreview = await patchActivity(ctx, owner, first.reference, {
        requestKey: "t2-f2-missing-edit",
        expectedVersion: 1,
        scope: "THIS_AND_FUTURE",
        name: "Updated name",
      });
      expect(missingEditPreview.status).toBe(400);
      expect(missingEditPreview.body.error.code).toBe("VALIDATION_FAILED");

      const missingCancelPreview = await cancelActivity(ctx, owner, first.reference, {
        requestKey: "t2-f2-missing-cancel",
        expectedVersion: 1,
        scope: "THIS_AND_FUTURE",
        reason: "No preview sent",
      });
      expect(missingCancelPreview.status).toBe(400);
      expect(missingCancelPreview.body.error.code).toBe("VALIDATION_FAILED");

      // Preview 3-entry cancellation.
      const cancelPreview = await cancelActivity(ctx, owner, first.reference, {
        preview: true,
        expectedVersion: 1,
        scope: "THIS_AND_FUTURE",
      });
      expect(cancelPreview.status).toBe(200);
      expect(cancelPreview.body.affectedReferences).toEqual([first.reference, second.reference, third.reference]);
      expect(cancelPreview.body.affectedVersions).toEqual({
        [first.reference]: 1,
        [second.reference]: 1,
        [third.reference]: 1,
      });

      // Partial expectedAffectedVersions (only 1st entry's version) rejected with 400.
      const partialCancel = await cancelActivity(ctx, owner, first.reference, {
        requestKey: "t2-f2-partial-cancel",
        expectedVersion: 1,
        scope: "THIS_AND_FUTURE",
        reason: "Partial versions",
        expectedAffectedReferences: [first.reference, second.reference, third.reference],
        expectedAffectedVersions: { [first.reference]: 1 },
      });
      expect(partialCancel.status).toBe(400);
      expect(partialCancel.body.error.code).toBe("VALIDATION_FAILED");

      const partialEdit = await patchActivity(ctx, owner, first.reference, {
        requestKey: "t2-f2-partial-edit",
        expectedVersion: 1,
        scope: "THIS_AND_FUTURE",
        name: "Partial version edit",
        expectedAffectedReferences: [first.reference, second.reference, third.reference],
        expectedAffectedVersions: { [first.reference]: 1 },
      });
      expect(partialEdit.status).toBe(400);
      expect(partialEdit.body.error.code).toBe("VALIDATION_FAILED");

      // Edit 2nd entry after preview -> 2nd entry moves to version 2.
      const editSecond = await patchActivity(ctx, owner, second.reference, {
        requestKey: "t2-f2-edit-second",
        expectedVersion: 1,
        scope: "THIS_OCCURRENCE",
        scheduledDate: "2026-11-11",
        scheduledTime: "11:00",
      });
      expect(editSecond.status).toBe(200);
      expect(editSecond.body.version).toBe(2);

      // Submitting stale preview versions fails with 409 STALE_ACTIVITY and cancels nothing.
      const staleCancel = await cancelActivity(ctx, owner, first.reference, {
        requestKey: "t2-f2-stale-cancel",
        expectedVersion: 1,
        scope: "THIS_AND_FUTURE",
        reason: "Stale preview cancel",
        expectedAffectedReferences: cancelPreview.body.affectedReferences,
        expectedAffectedVersions: cancelPreview.body.affectedVersions,
      });
      expect(staleCancel.status).toBe(409);
      expect(staleCancel.body.error.code).toBe("STALE_ACTIVITY");

      for (const ref of [first.reference, second.reference, third.reference]) {
        const check = await request(ctx.app).get(`/api/calendar/activities/${ref}`).set("Cookie", owner.cookie);
        expect(check.body.status).not.toBe("CANCELLED");
      }

      // Fresh preview succeeds and same-key replay preserves result.
      const freshPreview = await cancelActivity(ctx, owner, first.reference, {
        preview: true,
        expectedVersion: 1,
        scope: "THIS_AND_FUTURE",
      });
      expect(freshPreview.body.affectedVersions).toEqual({
        [first.reference]: 1,
        [second.reference]: 2,
        [third.reference]: 1,
      });

      const cancelSaved = await cancelActivity(ctx, owner, first.reference, {
        requestKey: "t2-f2-fresh-cancel",
        expectedVersion: 1,
        scope: "THIS_AND_FUTURE",
        reason: "Confirmed after reload",
        expectedAffectedReferences: freshPreview.body.affectedReferences,
        expectedAffectedVersions: freshPreview.body.affectedVersions,
      });
      expect(cancelSaved.status).toBe(200);
      expect(cancelSaved.body.replayed).toBe(false);

      const cancelReplay = await cancelActivity(ctx, owner, first.reference, {
        requestKey: "t2-f2-fresh-cancel",
        expectedVersion: 1,
        scope: "THIS_AND_FUTURE",
        reason: "Confirmed after reload",
        expectedAffectedReferences: freshPreview.body.affectedReferences,
        expectedAffectedVersions: freshPreview.body.affectedVersions,
      });
      expect(cancelReplay.status).toBe(200);
      expect(cancelReplay.body.replayed).toBe(true);
      expect(cancelReplay.body.affectedReferences).toEqual([first.reference, second.reference, third.reference]);
    });
  });

  describe("completion corrections (Task 3)", () => {
    it("records work done before activity creation while preserving creation, actual, and recording timestamps separately", async () => {
      ctx.clock.set("2026-11-10T10:00:00+08:00");
      owner = await reauth(ctx, "owner1", owner);
      cashier = await reauth(ctx, "cashier1", cashier);

      const created = await scheduleActivity(ctx, owner, {
        requestKey: "t3-predate-seed",
        name: "Backdated filter change",
        scheduledDate: "2026-11-10",
        scheduledTime: "14:00",
      });
      expect(created.status).toBe(201);
      const ref = created.body.reference as string;

      ctx.clock.set("2026-11-10T10:05:00+08:00");
      const completed = await completeActivity(ctx, owner, ref, {
        completedDate: "2026-11-09",
        completedTime: "16:00",
        completionNotes: "Changed yesterday afternoon before logging.",
        confirmed: true,
      });
      expect(completed.status).toBe(200);
      expect(completed.body.status).toBe("COMPLETED");
      expect(completed.body.createdAt).toBe("2026-11-10T10:00:00+08:00");
      expect(completed.body.completion).toMatchObject({
        actualCompletedAt: "2026-11-09T16:00:00+08:00",
        completedDate: "2026-11-09",
        completedTime: "16:00",
        recordedAt: "2026-11-10T10:05:00+08:00",
        originalActualCompletedAt: "2026-11-09T16:00:00+08:00",
        originalCompletedDate: "2026-11-09",
        originalCompletedTime: "16:00",
        originalCompletionNotes: "Changed yesterday afternoon before logging.",
        corrections: [],
      });
    });

    it("corrects completion details across a Manila month boundary and preserves original, creation, and recording history for both roles", async () => {
      const mCtx = await createTestContext({ clock: new ManualClock("2026-10-31T23:00:00+08:00") });
      try {
        let mOwner = await activatedAccount(mCtx, "owner1", "OWNER");
        let mEmployee = await activatedAccount(mCtx, "emp1", "EMPLOYEE");

        const created = await scheduleActivity(mCtx, mOwner, {
          requestKey: "t3-month-seed",
          name: "Month-end tank rinse",
          scheduledDate: "2026-10-31",
          scheduledTime: "22:00",
        });
        expect(created.status).toBe(201);
        const ref = created.body.reference as string;

        mCtx.clock.set("2026-10-31T23:10:00+08:00");
        mOwner = await reauth(mCtx, "owner1", mOwner);
        const initialDone = await completeActivity(mCtx, mOwner, ref, {
          completedDate: "2026-10-31",
          completedTime: "22:30",
          completionNotes: "Initial tank rinse.",
          confirmed: true,
        });
        expect(initialDone.status).toBe(200);
        expect(initialDone.body.version).toBe(2);

        // Correct after Manila midnight to 2026-11-01 00:30+08:00 (still Oct 31 16:30Z in UTC).
        mCtx.clock.set("2026-11-01T01:00:00+08:00");
        mOwner = await reauth(mCtx, "owner1", mOwner);
        mEmployee = await reauth(mCtx, "emp1", mEmployee);

        const corrected1 = await patchCompletion(mCtx, mOwner, ref, {
          requestKey: "t3-month-corr-1",
          expectedVersion: 2,
          completedDate: "2026-11-01",
          completedTime: "00:30",
          completionNotes: "Finished after Manila midnight.",
          reason: "Logged wrong day after midnight",
          confirmed: true,
        });
        expect(corrected1.status).toBe(200);
        expect(corrected1.body.replayed).toBe(false);
        expect(corrected1.body.status).toBe("COMPLETED");
        expect(corrected1.body.version).toBe(3);
        expect(corrected1.body.createdAt).toBe("2026-10-31T23:00:00+08:00");
        expect(corrected1.body.completion).toMatchObject({
          actualCompletedAt: "2026-11-01T00:30:00+08:00",
          completedDate: "2026-11-01",
          completedTime: "00:30",
          completionNotes: "Finished after Manila midnight.",
          recordedBy: "owner1",
          recordedAt: "2026-10-31T23:10:00+08:00",
          originalActualCompletedAt: "2026-10-31T22:30:00+08:00",
          originalCompletedDate: "2026-10-31",
          originalCompletedTime: "22:30",
          originalCompletionNotes: "Initial tank rinse.",
        });
        expect(corrected1.body.completion.corrections).toHaveLength(1);
        expect(corrected1.body.completion.corrections[0]).toMatchObject({
          previousCompletedDate: "2026-10-31",
          previousCompletedTime: "22:30",
          previousCompletionNotes: "Initial tank rinse.",
          newCompletedDate: "2026-11-01",
          newCompletedTime: "00:30",
          newCompletionNotes: "Finished after Manila midnight.",
          reason: "Logged wrong day after midnight",
          correctedBy: "owner1",
          correctedAt: "2026-11-01T01:00:00+08:00",
        });

        // Second correction keeps original details and appends chronologically.
        mCtx.clock.set("2026-11-01T01:30:00+08:00");
        mOwner = await reauth(mCtx, "owner1", mOwner);
        mEmployee = await reauth(mCtx, "emp1", mEmployee);
        const corrected2 = await patchCompletion(mCtx, mOwner, ref, {
          requestKey: "t3-month-corr-2",
          expectedVersion: 3,
          completedDate: "2026-11-01",
          completedTime: "00:35",
          completionNotes: "Finished after Manila midnight and flushed drain.",
          reason: "Include drain flush detail",
          confirmed: true,
        });
        expect(corrected2.status).toBe(200);
        expect(corrected2.body.version).toBe(4);
        expect(corrected2.body.completion.corrections).toHaveLength(2);
        expect(corrected2.body.completion.originalCompletionNotes).toBe("Initial tank rinse.");
        expect(corrected2.body.completion.recordedAt).toBe("2026-10-31T23:10:00+08:00");

        // Employee monthly queries locate the entry by its corrected Manila completion month (November, not October).
        const octList = await request(mCtx.app)
          .get("/api/calendar/activities?month=2026-10")
          .set("Cookie", mEmployee.cookie);
        expect(octList.status).toBe(200);
        expect(octList.body.completedActivities).toEqual([]);

        const novList = await request(mCtx.app)
          .get("/api/calendar/activities?month=2026-11")
          .set("Cookie", mEmployee.cookie);
        expect(novList.status).toBe(200);
        expect(novList.body.completedActivities).toHaveLength(1);
        expect(novList.body.completedActivities[0]).toMatchObject({
          reference: ref,
          status: "COMPLETED",
          completion: {
            completedDate: "2026-11-01",
            completedTime: "00:35",
            originalCompletedDate: "2026-10-31",
            originalCompletedTime: "22:30",
            originalCompletionNotes: "Initial tank rinse.",
          },
        });
        expect(novList.body.completedActivities[0].completion.corrections).toHaveLength(2);
      } finally {
        await mCtx.close();
      }
    });

    it("enforces reason, future-time, confirmation, Employee 403, not-completed 409, stale version, and idempotent retry", async () => {
      const pending = await scheduleActivity(ctx, owner, {
        requestKey: "t3-val-pending",
        name: "Uncompleted valve check",
        scheduledDate: "2026-11-10",
        scheduledTime: "09:00",
      });
      expect(pending.status).toBe(201);

      const notCompleted = await patchCompletion(ctx, owner, pending.body.reference, {
        requestKey: "t3-val-not-done",
        expectedVersion: 1,
        completedDate: "2026-11-09",
        completedTime: "08:50",
        completionNotes: "Cannot correct pending task.",
        reason: "Correction attempt",
        confirmed: true,
      });
      expect(notCompleted.status).toBe(409);
      expect(notCompleted.body.error.code).toBe("ACTIVITY_NOT_COMPLETED");

      const done = await completeActivity(ctx, owner, pending.body.reference, {
        completedDate: "2026-11-09",
        completedTime: "08:45",
        completionNotes: "Initial notes.",
        confirmed: true,
      });
      expect(done.status).toBe(200);
      const ref = pending.body.reference as string;

      // Employee denied 403.
      const empDenied = await patchCompletion(ctx, cashier, ref, {
        requestKey: "t3-val-emp",
        expectedVersion: 2,
        completedDate: "2026-11-09",
        completedTime: "08:50",
        completionNotes: "Employee edit.",
        reason: "Should be denied",
        confirmed: true,
      });
      expect(empDenied.status).toBe(403);

      // Blank reason rejected.
      const blankReason = await patchCompletion(ctx, owner, ref, {
        requestKey: "t3-val-blank-reason",
        expectedVersion: 2,
        completedDate: "2026-11-09",
        completedTime: "08:50",
        completionNotes: "Updated notes.",
        reason: "   ",
        confirmed: true,
      });
      expect(blankReason.status).toBe(400);
      expect(blankReason.body.error.code).toBe("VALIDATION_FAILED");

      // Future completion time rejected (clock is 2026-11-09 09:00+08:00).
      const futureTime = await patchCompletion(ctx, owner, ref, {
        requestKey: "t3-val-future",
        expectedVersion: 2,
        completedDate: "2026-11-09",
        completedTime: "09:01",
        completionNotes: "Updated notes.",
        reason: "Future time",
        confirmed: true,
      });
      expect(futureTime.status).toBe(400);
      expect(futureTime.body.error.code).toBe("VALIDATION_FAILED");

      // Missing confirmation rejected.
      const unconfirmed = await patchCompletion(ctx, owner, ref, {
        requestKey: "t3-val-unconfirmed",
        expectedVersion: 2,
        completedDate: "2026-11-09",
        completedTime: "08:50",
        completionNotes: "Updated notes.",
        reason: "Missing confirmation",
        confirmed: false,
      });
      expect(unconfirmed.status).toBe(400);
      expect(unconfirmed.body.error.code).toBe("VALIDATION_FAILED");

      // Stale version rejected.
      const staleVersion = await patchCompletion(ctx, owner, ref, {
        requestKey: "t3-val-stale",
        expectedVersion: 1,
        completedDate: "2026-11-09",
        completedTime: "08:50",
        completionNotes: "Updated notes.",
        reason: "Stale version",
        confirmed: true,
      });
      expect(staleVersion.status).toBe(409);
      expect(staleVersion.body.error.code).toBe("STALE_ACTIVITY");

      // Valid correction succeeds and supports same-key replay + mismatch rejection.
      const validPayload = {
        requestKey: "t3-val-ok",
        expectedVersion: 2,
        completedDate: "2026-11-09",
        completedTime: "08:55",
        completionNotes: "Corrected valve check notes.",
        reason: "Fix exact finish minute",
        confirmed: true,
      };
      const saved = await patchCompletion(ctx, owner, ref, validPayload);
      expect(saved.status).toBe(200);
      expect(saved.body.replayed).toBe(false);
      expect(saved.body.version).toBe(3);

      const replayed = await patchCompletion(ctx, owner, ref, validPayload);
      expect(replayed.status).toBe(200);
      expect(replayed.body.replayed).toBe(true);
      expect(replayed.body.version).toBe(3);
      expect(replayed.body.completion.corrections).toHaveLength(1);

      const keyConflict = await patchCompletion(ctx, owner, ref, {
        ...validPayload,
        completionNotes: "Different payload on same key.",
      });
      expect(keyConflict.status).toBe(409);
      expect(keyConflict.body.error.code).toBe("REQUEST_KEY_CONFLICT");

      const { rows } = await ctx.db.query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM calendar_completion_corrections",
      );
      expect(Number(rows[0]!.count)).toBe(1);
    });

    it("orders equal-timestamp completion corrections deterministically by save sequence (Finding 2)", async () => {
      const created = await scheduleActivity(ctx, owner, {
        requestKey: "t3-f2-seq-seed",
        name: "Sequential corrections",
        scheduledDate: "2026-11-10",
        scheduledTime: "09:00",
      });
      expect(created.status).toBe(201);
      const ref = created.body.reference as string;

      const done = await completeActivity(ctx, owner, ref, {
        completedDate: "2026-11-09",
        completedTime: "08:30",
        completionNotes: "Note 0",
        confirmed: true,
      });
      expect(done.status).toBe(200);

      // Keep clock frozen so all 6 corrections share the exact same correctedAt timestamp.
      let expectedVersion = done.body.version as number;
      for (let step = 1; step <= 6; step += 1) {
        const res = await patchCompletion(ctx, owner, ref, {
          requestKey: `t3-f2-seq-${step}`,
          expectedVersion,
          completedDate: "2026-11-09",
          completedTime: `08:${String(30 + step).padStart(2, "0")}`,
          completionNotes: `Note ${step}`,
          reason: `Reason ${step}`,
          confirmed: true,
        });
        expect(res.status).toBe(200);
        expectedVersion = res.body.version as number;
      }

      const empDetail = await request(ctx.app).get(`/api/calendar/activities/${ref}`).set("Cookie", cashier.cookie);
      expect(empDetail.status).toBe(200);
      const corrections = empDetail.body.completion.corrections as Array<any>;
      expect(corrections).toHaveLength(6);
      expect(empDetail.body.completion.originalCompletionNotes).toBe("Note 0");
      expect(empDetail.body.completion.completionNotes).toBe("Note 6");
      for (let i = 0; i < 6; i += 1) {
        expect(corrections[i].previousCompletionNotes).toBe(`Note ${i}`);
        expect(corrections[i].newCompletionNotes).toBe(`Note ${i + 1}`);
        if (i > 0) {
          expect(corrections[i].previousCompletionNotes).toBe(corrections[i - 1].newCompletionNotes);
          expect(corrections[i].correctedAt).toBe(corrections[0].correctedAt);
        }
      }
    });

    it("reads activity, month lists, and history from a single snapshot during a concurrent month-boundary correction (Finding 1)", async () => {
      const sCtx = await createTestContext({ clock: new ManualClock("2026-10-31T23:00:00+08:00") });
      try {
        let sOwner = await activatedAccount(sCtx, "owner1", "OWNER");
        let sEmp = await activatedAccount(sCtx, "emp1", "EMPLOYEE");

        const created = await scheduleActivity(sCtx, sOwner, {
          requestKey: "t3-f1-snap-seed",
          name: "Concurrent snapshot activity",
          scheduledDate: "2026-10-31",
          scheduledTime: "22:00",
        });
        const ref = created.body.reference as string;

        const done = await completeActivity(sCtx, sOwner, ref, {
          completedDate: "2026-10-31",
          completedTime: "22:30",
          completionNotes: "Initial notes",
          confirmed: true,
        });
        expect(done.status).toBe(200);

        sCtx.clock.set("2026-11-01T00:45:00+08:00");
        sOwner = await reauth(sCtx, "owner1", sOwner);
        sEmp = await reauth(sCtx, "emp1", sEmp);

        // Spy on db.transaction to prove GET detail and GET month run inside REPEATABLE READ READ ONLY snapshots,
        // and race reads against the month-boundary correction.
        let readOnlySnapshotCount = 0;
        const originalTx = sCtx.db.transaction.bind(sCtx.db);
        sCtx.db.transaction = (async (fn: Parameters<typeof originalTx>[0]) => {
          return originalTx(async (tx) => {
            const origQuery = tx.query.bind(tx);
            tx.query = (async (sql: string, params?: unknown[]) => {
              if (sql.includes("REPEATABLE READ READ ONLY")) {
                readOnlySnapshotCount += 1;
              }
              return origQuery(sql, params);
            }) as typeof tx.query;
            return fn(tx);
          });
        }) as typeof sCtx.db.transaction;

        const [corrRes, detailRes, octRes, novRes] = await Promise.all([
          patchCompletion(sCtx, sOwner, ref, {
            requestKey: "t3-f1-corr",
            expectedVersion: 2,
            completedDate: "2026-11-01",
            completedTime: "00:30",
            completionNotes: "Corrected notes",
            reason: "Crossed Manila midnight",
            confirmed: true,
          }),
          request(sCtx.app).get(`/api/calendar/activities/${ref}`).set("Cookie", sEmp.cookie),
          request(sCtx.app).get("/api/calendar/activities?month=2026-10").set("Cookie", sEmp.cookie),
          request(sCtx.app).get("/api/calendar/activities?month=2026-11").set("Cookie", sEmp.cookie),
        ]);

        expect(corrRes.status).toBe(200);
        expect(readOnlySnapshotCount).toBe(3);

        for (const item of [
          detailRes.body,
          ...octRes.body.completedActivities,
          ...novRes.body.completedActivities,
        ]) {
          if (item.version === 2) {
            expect(item.completion.completionNotes).toBe("Initial notes");
            expect(item.completion.corrections).toHaveLength(0);
          } else {
            expect(item.version).toBe(3);
            expect(item.completion.completionNotes).toBe("Corrected notes");
            expect(item.completion.corrections).toHaveLength(1);
          }
        }
      } finally {
        await sCtx.close();
      }
    });
  });

  describe("Task 4 browser/recovery hardening", () => {
    it("replays an identical interrupted completion save and rejects conflicting retries with 409 STALE_ACTIVITY (Finding 2)", async () => {
      const created = await scheduleActivity(ctx, owner, {
        requestKey: "t4-f2-replay-seed",
        name: "Interrupted completion check",
        scheduledDate: "2026-11-11",
        scheduledTime: "10:00",
      });
      expect(created.status).toBe(201);
      const ref = created.body.reference as string;

      const payload = {
        expectedVersion: 1,
        completedDate: "2026-11-09",
        completedTime: "08:45",
        completionNotes: "Completed before drop.",
        confirmed: true,
      };
      const firstSave = await completeActivity(ctx, owner, ref, payload);
      expect(firstSave.status).toBe(200);
      expect(firstSave.body.replayed).toBe(false);
      expect(firstSave.body.version).toBe(2);

      const identicalRetry = await completeActivity(ctx, owner, ref, payload);
      expect(identicalRetry.status).toBe(200);
      expect(identicalRetry.body.replayed).toBe(true);
      expect(identicalRetry.body.version).toBe(2);
      expect(identicalRetry.body.completion.completionNotes).toBe("Completed before drop.");

      const differentNoteRetry = await completeActivity(ctx, owner, ref, {
        ...payload,
        completionNotes: "Different completion note.",
      });
      expect(differentNoteRetry.status).toBe(409);
      expect(differentNoteRetry.body.error.code).toBe("STALE_ACTIVITY");

      const differentTimeRetry = await completeActivity(ctx, owner, ref, {
        ...payload,
        completedTime: "08:40",
      });
      expect(differentTimeRetry.status).toBe(409);
      expect(differentTimeRetry.body.error.code).toBe("STALE_ACTIVITY");

      // After a schedule edit bumps version on an unfinished activity, stale expectedVersion still gets 409 STALE_ACTIVITY.
      const unfinished = await scheduleActivity(ctx, owner, {
        requestKey: "t4-f2-edited-seed",
        name: "Schedule edited before completion",
        scheduledDate: "2026-11-12",
        scheduledTime: "10:00",
      });
      expect(unfinished.status).toBe(201);
      const editedRef = unfinished.body.reference as string;

      const edited = await patchActivity(ctx, owner, editedRef, {
        requestKey: "t4-f2-edited-bump",
        expectedVersion: 1,
        scope: "THIS_OCCURRENCE",
        scheduledDate: "2026-11-12",
        scheduledTime: "11:00",
      });
      expect(edited.status).toBe(200);

      const staleUnfinished = await completeActivity(ctx, owner, editedRef, payload);
      expect(staleUnfinished.status).toBe(409);
      expect(staleUnfinished.body.error.code).toBe("STALE_ACTIVITY");

      const { rows } = await ctx.db.query<{ count: string }>(
        `SELECT COUNT(*) AS count
           FROM calendar_completions c
           JOIN calendar_occurrences o ON o.id = c.occurrence_id
          WHERE o.reference = $1`,
        [ref],
      );
      expect(Number(rows[0]!.count)).toBe(1);
    });
  });
});
