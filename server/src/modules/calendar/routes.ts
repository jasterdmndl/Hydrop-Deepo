import { Router } from "express";
import { z } from "zod";
import type { Database, Queryable } from "../../db/database.js";
import { sendError } from "../../shared/http.js";
import { requireRole } from "../auth/guards.js";
import {
  type ActivityEditScope,
  type ActivityView,
  calendarPermissions,
  conflictSetsEqual,
  formatManilaDate,
  formatManilaIso,
  formatManilaTime,
  manilaDayDelta,
  manilaMonthDayCode,
  manilaMonthDelta,
  manilaParts,
  manilaReminderWindow,
  parseManilaDateTimeInput,
  parseManilaMonth,
  shiftManilaDateKeepingTime,
  shiftManilaMonthlyKeepingPreferredDay,
  type RecurrenceRule,
  type ReminderItem,
} from "./calendar.js";
import { generateOccurrenceSchedule } from "./recurrence.js";
import {
  calendarRepository as repo,
  type OccurrenceDbRow,
  toActivityView,
  toSeriesSummary,
} from "./repository.js";

const scheduleBody = z.object({
  name: z.string().trim().min(1, "Enter an activity name.").max(120),
  scheduledDate: z.string().optional(),
  scheduledTime: z.string().optional(),
  scheduledAt: z.string().optional(),
  scheduleNotes: z.string().max(1000).optional(),
  notes: z.string().max(1000).optional(),
  recurrence: z.enum(["ONE_TIME", "DAILY", "WEEKLY", "MONTHLY"]).optional(),
  endDate: z.string().optional(),
  requestKey: z.string().trim().min(1).max(128).optional(),
  acknowledgedConflictReferences: z.array(z.string().trim().min(1)).optional(),
  confirmedConflictReferences: z.array(z.string().trim().min(1)).optional(),
});

const editBody = z.object({
  expectedVersion: z.number().int().min(1),
  requestKey: z.string().trim().min(1).max(128).optional(),
  scope: z.enum(["THIS_OCCURRENCE", "THIS_AND_FUTURE"]).optional(),
  preview: z.boolean().optional(),
  name: z.string().trim().min(1, "Enter an activity name.").max(120).optional(),
  scheduledDate: z.string().optional(),
  scheduledTime: z.string().optional(),
  scheduledAt: z.string().optional(),
  scheduleNotes: z.string().max(1000).optional(),
  notes: z.string().max(1000).optional(),
  expectedAffectedReferences: z.array(z.string().trim().min(1)).optional(),
  expectedAffectedVersions: z.record(z.string(), z.number().int().min(1)).optional(),
  acknowledgedConflictReferences: z.array(z.string().trim().min(1)).optional(),
  confirmedConflictReferences: z.array(z.string().trim().min(1)).optional(),
});

const cancelBody = z.object({
  expectedVersion: z.number().int().min(1),
  requestKey: z.string().trim().min(1).max(128).optional(),
  scope: z.enum(["THIS_OCCURRENCE", "THIS_AND_FUTURE"]).optional(),
  preview: z.boolean().optional(),
  reason: z.string().max(500).optional(),
  expectedAffectedReferences: z.array(z.string().trim().min(1)).optional(),
  expectedAffectedVersions: z.record(z.string(), z.number().int().min(1)).optional(),
});

const completionBody = z.object({
  expectedVersion: z.number().int().min(1).optional(),
  completedDate: z.string().optional(),
  completedTime: z.string().optional(),
  completedAt: z.string().optional(),
  actualCompletedAt: z.string().optional(),
  completionNotes: z.string().max(1000).optional(),
  notes: z.string().max(1000).optional(),
  confirmed: z.boolean().optional(),
  confirmCompleted: z.boolean().optional(),
});

const correctCompletionBody = z.object({
  expectedVersion: z.number().int().min(1),
  requestKey: z.string().trim().min(1).max(128).optional(),
  completedDate: z.string().optional(),
  completedTime: z.string().optional(),
  completedAt: z.string().optional(),
  actualCompletedAt: z.string().optional(),
  completionNotes: z.string().max(1000).optional(),
  notes: z.string().max(1000).optional(),
  reason: z.string().max(500).optional(),
  confirmed: z.boolean().optional(),
  confirmCompleted: z.boolean().optional(),
});

function normalizeNotes(primary?: string, fallback?: string): string | null {
  const raw = (primary ?? fallback ?? "").trim();
  return raw.length > 0 ? raw : null;
}

function paramReference(raw: string | string[] | undefined): string {
  return typeof raw === "string" ? raw.trim() : "";
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function extractRequestKey(bodyKey: string | undefined, req: { get(name: string): string | undefined }): string {
  return (bodyKey ?? req.get("idempotency-key") ?? req.get("x-request-key") ?? "").trim();
}

async function readSnapshot<T>(db: Database, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    return fn(tx);
  });
}

async function hydrateViews(db: Queryable, rows: OccurrenceDbRow[], now: Date): Promise<ActivityView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [changesByOccurrence, correctionsByOccurrence] = await Promise.all([
    repo.loadChangesByOccurrenceIds(db, ids),
    repo.loadCompletionCorrectionsByOccurrenceIds(db, ids),
  ]);
  return rows.map((row) =>
    toActivityView(
      row,
      now,
      changesByOccurrence.get(row.id) ?? [],
      correctionsByOccurrence.get(row.id) ?? [],
    ),
  );
}

function resolveAffectedScope(
  targetRow: OccurrenceDbRow,
  seriesRows: OccurrenceDbRow[],
  requestedScope: ActivityEditScope,
  now: Date,
): {
  effectiveScope: ActivityEditScope;
  affected: OccurrenceDbRow[];
  protectedRows: OccurrenceDbRow[];
} {
  if (!targetRow.seriesId || requestedScope === "THIS_OCCURRENCE") {
    return { effectiveScope: "THIS_OCCURRENCE", affected: [targetRow], protectedRows: [] };
  }

  const targetIdx = seriesRows.findIndex((r) => r.id === targetRow.id);
  const affected: OccurrenceDbRow[] = [targetRow];
  const protectedRows: OccurrenceDbRow[] = [];

  for (let i = 0; i < seriesRows.length; i += 1) {
    if (i <= targetIdx) continue;
    const row = seriesRows[i]!;
    const finished = row.actualCompletedAt !== null;
    const cancelled = row.cancelledAt !== null;
    const upcoming = toDate(row.scheduledAt).getTime() >= now.getTime();
    if (!finished && !cancelled && upcoming) {
      affected.push(row);
    } else {
      protectedRows.push(row);
    }
  }

  return { effectiveScope: "THIS_AND_FUTURE", affected, protectedRows };
}

function conflictSummary(conflicts: OccurrenceDbRow[]): {
  conflictReferences: string[];
  conflictDates: string[];
} {
  const conflictReferences: string[] = [];
  const seenRefs = new Set<string>();
  const conflictDates: string[] = [];
  const seenDates = new Set<string>();
  for (const c of conflicts) {
    if (!seenRefs.has(c.reference)) {
      seenRefs.add(c.reference);
      conflictReferences.push(c.reference);
    }
    const cDate = formatManilaDate(toDate(c.scheduledAt));
    if (!seenDates.has(cDate)) {
      seenDates.add(cDate);
      conflictDates.push(cDate);
    }
  }
  return { conflictReferences, conflictDates };
}

function buildVersionMap(rows: OccurrenceDbRow[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const row of rows) {
    map[row.reference] = row.version;
  }
  return map;
}

function validateBulkPreview(input: {
  effectiveScope: ActivityEditScope;
  affected: OccurrenceDbRow[];
  affectedReferences: string[];
  expectedAffectedReferences?: string[];
  expectedAffectedVersions?: Record<string, number>;
}):
  | { ok: true }
  | { ok: false; kind: "preview-required" | "partial-versions" | "stale-scope" | "stale-activity" } {
  const { effectiveScope, affected, affectedReferences, expectedAffectedReferences, expectedAffectedVersions } = input;

  if (effectiveScope === "THIS_AND_FUTURE" && (!expectedAffectedReferences || !expectedAffectedVersions)) {
    return { ok: false, kind: "preview-required" };
  }

  if (
    expectedAffectedReferences !== undefined &&
    !sameReferenceOrder(expectedAffectedReferences, affectedReferences)
  ) {
    return { ok: false, kind: "stale-scope" };
  }

  if (expectedAffectedVersions !== undefined) {
    if (effectiveScope === "THIS_AND_FUTURE") {
      const keys = Object.keys(expectedAffectedVersions);
      if (keys.length !== affectedReferences.length) {
        return { ok: false, kind: "partial-versions" };
      }
      for (const ref of affectedReferences) {
        if (!Object.prototype.hasOwnProperty.call(expectedAffectedVersions, ref)) {
          return { ok: false, kind: "partial-versions" };
        }
      }
    }

    for (const row of affected) {
      const expectedVer = expectedAffectedVersions[row.reference];
      if (expectedVer !== undefined && expectedVer !== row.version) {
        return { ok: false, kind: "stale-activity" };
      }
    }
  }

  return { ok: true };
}

function sameReferenceOrder(expected: string[], actual: string[]): boolean {
  if (expected.length !== actual.length) return false;
  for (let i = 0; i < expected.length; i += 1) {
    if (expected[i] !== actual[i]) return false;
  }
  return true;
}

/**
 * Calendar HTTP endpoints, mounted at /api/calendar behind the shared
 * module-access guards. All writes require the OWNER role.
 */
export function calendarRoutes(db: Database): Router {
  const router = Router();

  router.get("/access", (req, res) => {
    res.json(calendarPermissions(req.auth!.user.role));
  });

  router.get("/activities", async (req, res) => {
    const rawMonth = typeof req.query.month === "string" ? req.query.month : undefined;
    const window = parseManilaMonth(rawMonth, req.now);
    if (!window) {
      sendError(res, 400, "VALIDATION_FAILED", "Use YYYY-MM for the month filter.");
      return;
    }

    const payload = await readSnapshot(db, async (tx) => {
      const [scheduledRows, completedRows, cancelledRows] = await Promise.all([
        repo.listScheduledInWindow(tx, window.startUtc, window.endUtc),
        repo.listCompletedInWindow(tx, window.startUtc, window.endUtc),
        repo.listCancelledInWindow(tx, window.startUtc, window.endUtc),
      ]);

      const allRows = [...scheduledRows, ...completedRows, ...cancelledRows];
      const allIds = allRows.map((r) => r.id);
      const [changesByOccurrence, correctionsByOccurrence] = await Promise.all([
        repo.loadChangesByOccurrenceIds(tx, allIds),
        repo.loadCompletionCorrectionsByOccurrenceIds(tx, allIds),
      ]);

      return {
        month: window.month,
        scheduledActivities: scheduledRows.map((row) =>
          toActivityView(
            row,
            req.now,
            changesByOccurrence.get(row.id) ?? [],
            correctionsByOccurrence.get(row.id) ?? [],
          ),
        ),
        completedActivities: completedRows.map((row) =>
          toActivityView(
            row,
            req.now,
            changesByOccurrence.get(row.id) ?? [],
            correctionsByOccurrence.get(row.id) ?? [],
          ),
        ),
        cancelledActivities: cancelledRows.map((row) =>
          toActivityView(
            row,
            req.now,
            changesByOccurrence.get(row.id) ?? [],
            correctionsByOccurrence.get(row.id) ?? [],
          ),
        ),
      };
    });

    res.json(payload);
  });

  router.get("/activities/:reference", async (req, res) => {
    const reference = paramReference(req.params.reference);
    if (!reference) {
      sendError(res, 404, "NOT_FOUND", "Activity not found.");
      return;
    }
    const activity = await readSnapshot(db, async (tx) => {
      const row = await repo.findByReference(tx, reference);
      if (!row) return null;
      const [view] = await hydrateViews(tx, [row], req.now);
      return view!;
    });
    if (!activity) {
      sendError(res, 404, "NOT_FOUND", "Activity not found.");
      return;
    }
    res.json({ ...activity, activity });
  });

  router.post("/activities", requireRole("OWNER"), async (req, res) => {
    const parsed = scheduleBody.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_FAILED", "Enter the activity name, scheduled date, and scheduled time.");
      return;
    }

    const body = parsed.data;
    const requestKey = extractRequestKey(body.requestKey, req);
    if (!requestKey || requestKey.length > 128) {
      sendError(res, 400, "VALIDATION_FAILED", "A schedule request key is required.");
      return;
    }

    const scheduledAt = parseManilaDateTimeInput({
      date: body.scheduledDate,
      time: body.scheduledTime,
      iso: body.scheduledAt,
      truncateToMinute: true,
    });
    if (!scheduledAt) {
      sendError(res, 400, "VALIDATION_FAILED", "Enter a valid scheduled date and time.");
      return;
    }

    const scheduleNotes = normalizeNotes(body.scheduleNotes, body.notes);
    const recurrence: RecurrenceRule = body.recurrence ?? "ONE_TIME";
    const schedule = generateOccurrenceSchedule({
      scheduledAt,
      recurrence,
      endDate: body.endDate,
    });
    if (!schedule.ok) {
      sendError(res, 400, "VALIDATION_FAILED", schedule.message);
      return;
    }

    const acknowledgedRefs = body.acknowledgedConflictReferences ?? body.confirmedConflictReferences ?? [];

    const outcome = await db.transaction(async (tx) => {
      await repo.lockForSchedule(tx);

      const existingRequest = await repo.findScheduleRequestByKey(tx, requestKey);
      if (existingRequest) {
        const existingMs = toDate(existingRequest.scheduledAt).getTime();
        const matches =
          existingRequest.recurrence === recurrence &&
          existingRequest.name === body.name &&
          existingMs === scheduledAt.getTime() &&
          existingRequest.endDate === schedule.endDate &&
          existingRequest.scheduleNotes === scheduleNotes;
        if (!matches) {
          return { kind: "key-conflict" as const };
        }
        const rows = await repo.findByReferences(tx, existingRequest.occurrenceReferences);
        const series = existingRequest.seriesId
          ? ((await repo.findSeriesById(tx, existingRequest.seriesId)) ?? null)
          : null;
        const activities = await hydrateViews(tx, rows, req.now);
        return { kind: "replayed" as const, activities, series };
      }

      const legacyExisting = await repo.findByRequestKey(tx, requestKey);
      if (legacyExisting) {
        const existingMs = toDate(legacyExisting.scheduledAt).getTime();
        const matches =
          recurrence === "ONE_TIME" &&
          schedule.endDate === null &&
          legacyExisting.name === body.name &&
          existingMs === scheduledAt.getTime() &&
          legacyExisting.scheduleNotes === scheduleNotes;
        if (!matches) {
          return { kind: "key-conflict" as const };
        }
        const activities = await hydrateViews(tx, [legacyExisting], req.now);
        return { kind: "replayed" as const, activities, series: null };
      }

      const conflicts = await repo.findUnfinishedAtScheduledTimes(tx, schedule.occurrences);
      const { conflictReferences, conflictDates } = conflictSummary(conflicts);
      if (conflicts.length > 0 && !conflictSetsEqual(acknowledgedRefs, conflictReferences)) {
        const conflictViews = await hydrateViews(tx, conflicts, req.now);
        return { kind: "schedule-conflict" as const, conflicts: conflictViews, conflictReferences, conflictDates };
      }

      let series = null;
      if (recurrence !== "ONE_TIME" && schedule.endDate !== null) {
        const seriesReference = await repo.nextSeriesReferenceForMonthDay(tx, manilaMonthDayCode(scheduledAt));
        series = await repo.insertSeries(tx, {
          reference: seriesReference,
          recurrence,
          startDate: schedule.startDate,
          endDate: schedule.endDate,
          scheduledTime: schedule.scheduledTime,
          preferredDayOfMonth: schedule.preferredDayOfMonth,
          weekday: schedule.weekday,
          createdByUserId: req.auth!.user.id,
          createdAt: req.now,
        });
      }

      const mmdds = schedule.occurrences.map((occurrenceAt) => manilaMonthDayCode(occurrenceAt));
      const createdReferences = await repo.allocateReferencesForMonthDays(tx, mmdds);
      await repo.insertOccurrences(tx, {
        references: createdReferences,
        scheduledTimes: schedule.occurrences,
        requestKey: recurrence === "ONE_TIME" ? requestKey : null,
        name: body.name,
        scheduleNotes,
        seriesId: series?.id ?? null,
        createdByUserId: req.auth!.user.id,
        createdAt: req.now,
      });

      await repo.insertScheduleRequest(tx, {
        requestKey,
        recurrence,
        name: body.name,
        scheduledAt,
        endDate: schedule.endDate,
        scheduleNotes,
        seriesId: series?.id ?? null,
        occurrenceReferences: createdReferences,
        createdByUserId: req.auth!.user.id,
        createdAt: req.now,
      });

      const createdRows = await repo.findByReferences(tx, createdReferences);
      const activities = await hydrateViews(tx, createdRows, req.now);
      return { kind: "created" as const, activities, series };
    });

    if (outcome.kind === "key-conflict") {
      sendError(
        res,
        409,
        "REQUEST_KEY_CONFLICT",
        "This save key was already used for a different activity. Start a new save request.",
      );
      return;
    }

    if (outcome.kind === "schedule-conflict") {
      res.status(409).json({
        error: {
          code: "SCHEDULE_CONFLICT",
          message: "Another unfinished activity is already scheduled at this date and time.",
        },
        conflicts: outcome.conflicts,
        conflictReferences: outcome.conflictReferences,
        conflictDates: outcome.conflictDates,
      });
      return;
    }

    const activities = outcome.activities;
    const activity = activities[0]!;
    const series = toSeriesSummary(
      outcome.series,
      activities.map((item) => item.reference),
    );
    const replayed = outcome.kind === "replayed";
    res.status(replayed ? 200 : 201).json({ ...activity, activity, activities, series, replayed });
  });

  router.patch("/activities/:reference", requireRole("OWNER"), async (req, res) => {
    const reference = paramReference(req.params.reference);
    if (!reference) {
      sendError(res, 404, "NOT_FOUND", "Activity not found.");
      return;
    }

    const parsed = editBody.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_FAILED", "Enter valid activity update details.");
      return;
    }

    const body = parsed.data;
    const isPreview = body.preview === true;
    const requestKey = extractRequestKey(body.requestKey, req);
    if (!isPreview && (!requestKey || requestKey.length > 128)) {
      sendError(res, 400, "VALIDATION_FAILED", "A save request key is required.");
      return;
    }

    const requestedScope: ActivityEditScope = body.scope ?? "THIS_OCCURRENCE";
    const hasNotesField = body.scheduleNotes !== undefined || body.notes !== undefined;
    const hasScheduleField =
      body.scheduledDate !== undefined || body.scheduledTime !== undefined || body.scheduledAt !== undefined;
    if (body.name === undefined && !hasNotesField && !hasScheduleField) {
      sendError(res, 400, "VALIDATION_FAILED", "Enter at least one schedule change before saving.");
      return;
    }

    const acknowledgedRefs = body.acknowledgedConflictReferences ?? body.confirmedConflictReferences ?? [];

    const outcome = await db.transaction(async (tx) => {
      if (isPreview) {
        await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      } else {
        await repo.lockForSchedule(tx);

        const existingReq = await repo.findMutationRequestByKey(tx, requestKey);
        if (existingReq) {
          const replayFingerprint = JSON.stringify({
            targetReference: reference,
            expectedVersion: body.expectedVersion,
            scope: requestedScope,
            name: body.name ?? null,
            scheduledDate: body.scheduledDate ?? null,
            scheduledTime: body.scheduledTime ?? null,
            scheduledAt: body.scheduledAt ?? null,
            scheduleNotes: hasNotesField ? normalizeNotes(body.scheduleNotes, body.notes) : undefined,
            expectedAffectedReferences: body.expectedAffectedReferences ?? null,
            expectedAffectedVersions: body.expectedAffectedVersions ?? null,
          });
          if (
            existingReq.operation !== "EDIT" ||
            existingReq.targetReference !== reference ||
            existingReq.payloadFingerprint !== replayFingerprint
          ) {
            return { kind: "key-conflict" as const };
          }
          const replayedRows = await repo.findByReferences(tx, existingReq.affectedReferences);
          const activities = await hydrateViews(tx, replayedRows, req.now);
          return {
            kind: "replayed" as const,
            activities,
            affectedReferences: existingReq.affectedReferences,
          };
        }
      }

      const target = await repo.findByReference(tx, reference);
      if (!target) {
        return { kind: "not-found" as const };
      }
      if (target.cancelledAt !== null) {
        return { kind: "already-cancelled" as const };
      }
      if (target.actualCompletedAt !== null) {
        return { kind: "already-completed" as const };
      }
      if (target.version !== body.expectedVersion) {
        return { kind: "stale-activity" as const };
      }

      const seriesRows = target.seriesId ? await repo.findSeriesOccurrences(tx, target.seriesId) : [target];
      const { effectiveScope, affected, protectedRows } = resolveAffectedScope(
        target,
        seriesRows,
        requestedScope,
        req.now,
      );
      const affectedReferences = affected.map((r) => r.reference);
      const affectedVersions = buildVersionMap(affected);

      if (!isPreview) {
        const previewCheck = validateBulkPreview({
          effectiveScope,
          affected,
          affectedReferences,
          expectedAffectedReferences: body.expectedAffectedReferences,
          expectedAffectedVersions: body.expectedAffectedVersions,
        });
        if (!previewCheck.ok) {
          if (previewCheck.kind === "stale-scope") {
            const [affectedActivities, protectedActivities] = await Promise.all([
              hydrateViews(tx, affected, req.now),
              hydrateViews(tx, protectedRows, req.now),
            ]);
            return {
              kind: "stale-scope" as const,
              affectedActivities,
              affectedReferences,
              affectedVersions,
              protectedActivities,
            };
          }
          if (previewCheck.kind === "preview-required") {
            return { kind: "preview-required" as const };
          }
          if (previewCheck.kind === "partial-versions") {
            return { kind: "partial-versions" as const };
          }
          return { kind: "stale-activity" as const };
        }
      }

      const currentTargetAt = toDate(target.scheduledAt);
      let newTargetAt = currentTargetAt;
      if (hasScheduleField) {
        const resolved = parseManilaDateTimeInput({
          date:
            body.scheduledAt !== undefined
              ? undefined
              : (body.scheduledDate ?? formatManilaDate(currentTargetAt)),
          time:
            body.scheduledAt !== undefined
              ? undefined
              : (body.scheduledTime ?? formatManilaTime(currentTargetAt)),
          iso: body.scheduledAt,
          truncateToMinute: true,
        });
        if (!resolved) {
          return { kind: "invalid-schedule" as const };
        }
        newTargetAt = resolved;
      }

      const dayDelta = manilaDayDelta(currentTargetAt, newTargetAt);
      const monthDelta = manilaMonthDelta(currentTargetAt, newTargetAt);
      const dateChanged = formatManilaDate(currentTargetAt) !== formatManilaDate(newTargetAt);
      const targetTimeParts = manilaParts(newTargetAt);
      const isMonthlyBulkDateShift =
        hasScheduleField &&
        dateChanged &&
        effectiveScope === "THIS_AND_FUTURE" &&
        target.seriesRecurrence === "MONTHLY";
      const newName = body.name ?? target.name;
      const newNotes = hasNotesField ? normalizeNotes(body.scheduleNotes, body.notes) : undefined;

      const proposedUpdates: Array<{
        row: OccurrenceDbRow;
        newName: string;
        newScheduledAt: Date;
        newScheduleNotes: string | null;
      }> = [];

      for (const row of affected) {
        const rowAt = toDate(row.scheduledAt);
        const rowNextAt = hasScheduleField
          ? row.id === target.id
            ? newTargetAt
            : isMonthlyBulkDateShift
              ? shiftManilaMonthlyKeepingPreferredDay(
                rowAt,
                monthDelta,
                targetTimeParts.day,
                targetTimeParts.hour,
                targetTimeParts.minute,
              )
              : shiftManilaDateKeepingTime(rowAt, dayDelta, targetTimeParts.hour, targetTimeParts.minute)
          : rowAt;
        if (!rowNextAt) {
          return { kind: "invalid-schedule" as const };
        }
        proposedUpdates.push({
          row,
          newName: body.name !== undefined ? newName : row.name,
          newScheduledAt: rowNextAt,
          newScheduleNotes: newNotes !== undefined ? newNotes : row.scheduleNotes,
        });
      }

      const conflicts = await repo.findUnfinishedAtScheduledTimesExcluding(
        tx,
        proposedUpdates.map((u) => u.newScheduledAt),
        affected.map((r) => r.id),
      );
      const { conflictReferences, conflictDates } = conflictSummary(conflicts);

      if (isPreview) {
        const [affectedActivities, protectedActivities, conflictViews] = await Promise.all([
          hydrateViews(tx, affected, req.now),
          hydrateViews(tx, protectedRows, req.now),
          hydrateViews(tx, conflicts, req.now),
        ]);
        return {
          kind: "preview" as const,
          effectiveScope,
          affectedActivities,
          affectedReferences,
          affectedVersions,
          protectedActivities,
          conflicts: conflictViews,
          conflictReferences,
          conflictDates,
        };
      }

      if (conflicts.length > 0 && !conflictSetsEqual(acknowledgedRefs, conflictReferences)) {
        const conflictViews = await hydrateViews(tx, conflicts, req.now);
        return {
          kind: "schedule-conflict" as const,
          conflicts: conflictViews,
          conflictReferences,
          conflictDates,
          affectedReferences,
        };
      }

      await repo.updateOccurrencesSchedule(
        tx,
        proposedUpdates.map((u) => ({
          id: u.row.id,
          name: u.newName,
          scheduledAt: u.newScheduledAt,
          scheduleNotes: u.newScheduleNotes,
        })),
      );

      await repo.insertOccurrenceChanges(
        tx,
        proposedUpdates.map((u) => ({
          occurrenceId: u.row.id,
          changeType: "EDIT",
          scope: effectiveScope,
          requestKey,
          previousName: u.row.name,
          newName: u.newName,
          previousScheduledAt: toDate(u.row.scheduledAt),
          newScheduledAt: u.newScheduledAt,
          previousScheduleNotes: u.row.scheduleNotes,
          newScheduleNotes: u.newScheduleNotes,
          reason: null,
          changedByUserId: req.auth!.user.id,
          changedAt: req.now,
        })),
      );

      const fingerprint = JSON.stringify({
        targetReference: reference,
        expectedVersion: body.expectedVersion,
        scope: requestedScope,
        name: body.name ?? null,
        scheduledDate: body.scheduledDate ?? null,
        scheduledTime: body.scheduledTime ?? null,
        scheduledAt: body.scheduledAt ?? null,
        scheduleNotes: hasNotesField ? normalizeNotes(body.scheduleNotes, body.notes) : undefined,
        expectedAffectedReferences: body.expectedAffectedReferences ?? null,
        expectedAffectedVersions: body.expectedAffectedVersions ?? null,
      });

      await repo.insertMutationRequest(tx, {
        requestKey,
        operation: "EDIT",
        targetReference: reference,
        scope: effectiveScope,
        payloadFingerprint: fingerprint,
        responseStatus: 200,
        affectedReferences,
        createdByUserId: req.auth!.user.id,
        createdAt: req.now,
      });

      const updatedRows = await repo.findByReferences(tx, affectedReferences);
      const activities = await hydrateViews(tx, updatedRows, req.now);
      return { kind: "updated" as const, activities, affectedReferences };
    });

    if (outcome.kind === "not-found") {
      sendError(res, 404, "NOT_FOUND", "Activity not found.");
      return;
    }
    if (outcome.kind === "already-cancelled") {
      sendError(res, 409, "ACTIVITY_ALREADY_CANCELLED", "Cancelled activities cannot be edited.");
      return;
    }
    if (outcome.kind === "already-completed") {
      sendError(res, 409, "ACTIVITY_ALREADY_COMPLETED", "Completed activities cannot be edited.");
      return;
    }
    if (outcome.kind === "stale-activity") {
      sendError(
        res,
        409,
        "STALE_ACTIVITY",
        "This activity changed while you were editing it. Reload the activity and review the latest details.",
      );
      return;
    }
    if (outcome.kind === "preview-required") {
      sendError(res, 400, "VALIDATION_FAILED", "Preview the affected series entries before saving a bulk change.");
      return;
    }
    if (outcome.kind === "partial-versions") {
      sendError(
        res,
        400,
        "VALIDATION_FAILED",
        "Include the current version for every affected activity from the preview.",
      );
      return;
    }
    if (outcome.kind === "stale-scope") {
      res.status(409).json({
        error: {
          code: "STALE_SCOPE",
          message: "The affected series entries changed. Reload and review the updated list before saving.",
        },
        affectedReferences: outcome.affectedReferences,
        affectedVersions: outcome.affectedVersions,
        affectedActivities: outcome.affectedActivities,
        protectedActivities: outcome.protectedActivities,
      });
      return;
    }
    if (outcome.kind === "invalid-schedule") {
      sendError(res, 400, "VALIDATION_FAILED", "Enter a valid scheduled date and time.");
      return;
    }
    if (outcome.kind === "key-conflict") {
      sendError(
        res,
        409,
        "REQUEST_KEY_CONFLICT",
        "This save key was already used for a different edit. Start a new edit request.",
      );
      return;
    }
    if (outcome.kind === "preview") {
      res.status(200).json({
        preview: true,
        scope: outcome.effectiveScope,
        targetReference: reference,
        affectedReferences: outcome.affectedReferences,
        affectedVersions: outcome.affectedVersions,
        affectedActivities: outcome.affectedActivities,
        protectedActivities: outcome.protectedActivities,
        conflicts: outcome.conflicts,
        conflictReferences: outcome.conflictReferences,
        conflictDates: outcome.conflictDates,
      });
      return;
    }
    if (outcome.kind === "schedule-conflict") {
      res.status(409).json({
        error: {
          code: "SCHEDULE_CONFLICT",
          message: "Another unfinished activity is already scheduled at this date and time.",
        },
        conflicts: outcome.conflicts,
        conflictReferences: outcome.conflictReferences,
        conflictDates: outcome.conflictDates,
        affectedReferences: outcome.affectedReferences,
      });
      return;
    }

    const activities = outcome.activities;
    const activity = activities[0]!;
    res.status(200).json({
      ...activity,
      activity,
      activities,
      affectedReferences: outcome.affectedReferences,
      replayed: outcome.kind === "replayed",
    });
  });

  router.post("/activities/:reference/cancellation", requireRole("OWNER"), async (req, res) => {
    const reference = paramReference(req.params.reference);
    if (!reference) {
      sendError(res, 404, "NOT_FOUND", "Activity not found.");
      return;
    }

    const parsed = cancelBody.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_FAILED", "Enter a valid cancellation request.");
      return;
    }

    const body = parsed.data;
    const isPreview = body.preview === true;
    const reason = (body.reason ?? "").trim();
    if (!isPreview && reason.length === 0) {
      sendError(res, 400, "VALIDATION_FAILED", "Enter a short cancellation reason before cancelling.");
      return;
    }

    const requestKey = extractRequestKey(body.requestKey, req);
    if (!isPreview && (!requestKey || requestKey.length > 128)) {
      sendError(res, 400, "VALIDATION_FAILED", "A cancellation request key is required.");
      return;
    }

    const requestedScope: ActivityEditScope = body.scope ?? "THIS_OCCURRENCE";

    const outcome = await db.transaction(async (tx) => {
      if (isPreview) {
        await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      } else {
        await repo.lockForSchedule(tx);

        const existingReq = await repo.findMutationRequestByKey(tx, requestKey);
        if (existingReq) {
          const replayFingerprint = JSON.stringify({
            targetReference: reference,
            expectedVersion: body.expectedVersion,
            scope: requestedScope,
            reason,
            expectedAffectedReferences: body.expectedAffectedReferences ?? null,
            expectedAffectedVersions: body.expectedAffectedVersions ?? null,
          });
          if (
            existingReq.operation !== "CANCEL" ||
            existingReq.targetReference !== reference ||
            existingReq.payloadFingerprint !== replayFingerprint
          ) {
            return { kind: "key-conflict" as const };
          }
          const replayedRows = await repo.findByReferences(tx, existingReq.affectedReferences);
          const activities = await hydrateViews(tx, replayedRows, req.now);
          return {
            kind: "replayed" as const,
            activities,
            affectedReferences: existingReq.affectedReferences,
          };
        }
      }

      const target = await repo.findByReference(tx, reference);
      if (!target) {
        return { kind: "not-found" as const };
      }
      if (target.cancelledAt !== null) {
        return { kind: "already-cancelled" as const };
      }
      if (target.actualCompletedAt !== null) {
        return { kind: "already-completed" as const };
      }
      if (target.version !== body.expectedVersion) {
        return { kind: "stale-activity" as const };
      }

      const seriesRows = target.seriesId ? await repo.findSeriesOccurrences(tx, target.seriesId) : [target];
      const { effectiveScope, affected, protectedRows } = resolveAffectedScope(
        target,
        seriesRows,
        requestedScope,
        req.now,
      );
      const affectedReferences = affected.map((r) => r.reference);
      const affectedVersions = buildVersionMap(affected);

      if (!isPreview) {
        const previewCheck = validateBulkPreview({
          effectiveScope,
          affected,
          affectedReferences,
          expectedAffectedReferences: body.expectedAffectedReferences,
          expectedAffectedVersions: body.expectedAffectedVersions,
        });
        if (!previewCheck.ok) {
          if (previewCheck.kind === "stale-scope") {
            const [affectedActivities, protectedActivities] = await Promise.all([
              hydrateViews(tx, affected, req.now),
              hydrateViews(tx, protectedRows, req.now),
            ]);
            return {
              kind: "stale-scope" as const,
              affectedActivities,
              affectedReferences,
              affectedVersions,
              protectedActivities,
            };
          }
          if (previewCheck.kind === "preview-required") {
            return { kind: "preview-required" as const };
          }
          if (previewCheck.kind === "partial-versions") {
            return { kind: "partial-versions" as const };
          }
          return { kind: "stale-activity" as const };
        }
      }

      if (isPreview) {
        const [affectedActivities, protectedActivities] = await Promise.all([
          hydrateViews(tx, affected, req.now),
          hydrateViews(tx, protectedRows, req.now),
        ]);
        return {
          kind: "preview" as const,
          effectiveScope,
          affectedActivities,
          affectedReferences,
          affectedVersions,
          protectedActivities,
        };
      }

      await repo.cancelOccurrences(tx, {
        ids: affected.map((r) => r.id),
        reason,
        cancelledByUserId: req.auth!.user.id,
        cancelledAt: req.now,
      });

      await repo.insertOccurrenceChanges(
        tx,
        affected.map((row) => ({
          occurrenceId: row.id,
          changeType: "CANCEL",
          scope: effectiveScope,
          requestKey,
          previousName: row.name,
          newName: row.name,
          previousScheduledAt: toDate(row.scheduledAt),
          newScheduledAt: toDate(row.scheduledAt),
          previousScheduleNotes: row.scheduleNotes,
          newScheduleNotes: row.scheduleNotes,
          reason,
          changedByUserId: req.auth!.user.id,
          changedAt: req.now,
        })),
      );

      const fingerprint = JSON.stringify({
        targetReference: reference,
        expectedVersion: body.expectedVersion,
        scope: requestedScope,
        reason,
        expectedAffectedReferences: body.expectedAffectedReferences ?? null,
        expectedAffectedVersions: body.expectedAffectedVersions ?? null,
      });

      await repo.insertMutationRequest(tx, {
        requestKey,
        operation: "CANCEL",
        targetReference: reference,
        scope: effectiveScope,
        payloadFingerprint: fingerprint,
        responseStatus: 200,
        affectedReferences,
        createdByUserId: req.auth!.user.id,
        createdAt: req.now,
      });

      const updatedRows = await repo.findByReferences(tx, affectedReferences);
      const activities = await hydrateViews(tx, updatedRows, req.now);
      return { kind: "cancelled" as const, activities, affectedReferences };
    });

    if (outcome.kind === "not-found") {
      sendError(res, 404, "NOT_FOUND", "Activity not found.");
      return;
    }
    if (outcome.kind === "already-cancelled") {
      sendError(res, 409, "ACTIVITY_ALREADY_CANCELLED", "This activity is already cancelled.");
      return;
    }
    if (outcome.kind === "already-completed") {
      sendError(res, 409, "ACTIVITY_ALREADY_COMPLETED", "Completed activities cannot be cancelled.");
      return;
    }
    if (outcome.kind === "stale-activity") {
      sendError(
        res,
        409,
        "STALE_ACTIVITY",
        "This activity changed before cancellation finished. Reload the activity and review the latest details.",
      );
      return;
    }
    if (outcome.kind === "preview-required") {
      sendError(
        res,
        400,
        "VALIDATION_FAILED",
        "Preview the affected series entries before saving a bulk cancellation.",
      );
      return;
    }
    if (outcome.kind === "partial-versions") {
      sendError(
        res,
        400,
        "VALIDATION_FAILED",
        "Include the current version for every affected activity from the preview.",
      );
      return;
    }
    if (outcome.kind === "stale-scope") {
      res.status(409).json({
        error: {
          code: "STALE_SCOPE",
          message: "The affected series entries changed. Reload and review the updated list before cancelling.",
        },
        affectedReferences: outcome.affectedReferences,
        affectedVersions: outcome.affectedVersions,
        affectedActivities: outcome.affectedActivities,
        protectedActivities: outcome.protectedActivities,
      });
      return;
    }
    if (outcome.kind === "key-conflict") {
      sendError(
        res,
        409,
        "REQUEST_KEY_CONFLICT",
        "This cancellation key was already used for a different request.",
      );
      return;
    }
    if (outcome.kind === "preview") {
      res.status(200).json({
        preview: true,
        scope: outcome.effectiveScope,
        targetReference: reference,
        affectedReferences: outcome.affectedReferences,
        affectedVersions: outcome.affectedVersions,
        affectedActivities: outcome.affectedActivities,
        protectedActivities: outcome.protectedActivities,
      });
      return;
    }

    const activities = outcome.activities;
    const activity = activities[0]!;
    res.status(200).json({
      ...activity,
      activity,
      activities,
      affectedReferences: outcome.affectedReferences,
      replayed: outcome.kind === "replayed",
    });
  });

  router.post("/activities/:reference/completion", requireRole("OWNER"), async (req, res) => {
    const reference = paramReference(req.params.reference);
    if (!reference) {
      sendError(res, 404, "NOT_FOUND", "Activity not found.");
      return;
    }

    const parsed = completionBody.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_FAILED", "Enter the completion date, time, notes, and confirmation.");
      return;
    }

    const body = parsed.data;
    const confirmed = body.confirmed ?? body.confirmCompleted ?? false;
    if (confirmed !== true) {
      sendError(res, 400, "VALIDATION_FAILED", "Confirm that this activity has been completed.");
      return;
    }

    const completionNotes = normalizeNotes(body.completionNotes, body.notes);
    if (!completionNotes) {
      sendError(res, 400, "VALIDATION_FAILED", "Enter completion notes before saving.");
      return;
    }

    const actualCompletedAt = parseManilaDateTimeInput({
      date: body.completedDate,
      time: body.completedTime,
      iso: body.actualCompletedAt ?? body.completedAt,
    });
    if (!actualCompletedAt) {
      sendError(res, 400, "VALIDATION_FAILED", "Enter a valid completion date and time.");
      return;
    }

    if (actualCompletedAt.getTime() > req.now.getTime()) {
      sendError(res, 400, "VALIDATION_FAILED", "Completion time cannot be in the future.");
      return;
    }

    const outcome = await db.transaction(async (tx) => {
      await repo.lockForSchedule(tx);
      const locked = await repo.lockOccurrenceForCompletion(tx, reference);
      if (!locked) return { kind: "not-found" as const };
      if (locked.cancelledAt !== null) return { kind: "cancelled" as const };
      if (body.expectedVersion !== undefined && locked.version !== body.expectedVersion) {
        const current = await repo.findByReference(tx, reference);
        const isIdenticalReplay =
          current !== undefined &&
          current.cancelledAt === null &&
          current.version === body.expectedVersion + 1 &&
          current.actualCompletedAt !== null &&
          current.completionNotes !== null &&
          current.originalActualCompletedAt !== null &&
          current.originalCompletionNotes !== null &&
          toDate(current.actualCompletedAt).getTime() === actualCompletedAt.getTime() &&
          toDate(current.originalActualCompletedAt).getTime() === actualCompletedAt.getTime() &&
          current.completionNotes === completionNotes &&
          current.originalCompletionNotes === completionNotes &&
          current.recordedByUsername === req.auth!.user.username;
        if (isIdenticalReplay) {
          const [activity] = await hydrateViews(tx, [current], req.now);
          return { kind: "replayed" as const, activity: activity! };
        }
        return { kind: "stale-activity" as const };
      }

      const inserted = await repo.insertCompletionIfAbsent(tx, {
        occurrenceId: locked.id,
        actualCompletedAt,
        completionNotes,
        recordedByUserId: req.auth!.user.id,
        recordedAt: req.now,
      });
      const updated = await repo.findByReference(tx, reference);
      const [activity] = await hydrateViews(tx, [updated!], req.now);
      return { kind: (inserted ? "ok" : "replayed") as "ok" | "replayed", activity: activity! };
    });

    if (outcome.kind === "not-found") {
      sendError(res, 404, "NOT_FOUND", "Activity not found.");
      return;
    }
    if (outcome.kind === "cancelled") {
      sendError(res, 409, "ACTIVITY_ALREADY_CANCELLED", "Cancelled activities cannot be completed.");
      return;
    }
    if (outcome.kind === "stale-activity") {
      sendError(
        res,
        409,
        "STALE_ACTIVITY",
        "This activity changed before completion finished. Reload the activity and review the latest details.",
      );
      return;
    }

    res.status(200).json({ ...outcome.activity, activity: outcome.activity, replayed: outcome.kind === "replayed" });
  });

  router.patch("/activities/:reference/completion", requireRole("OWNER"), async (req, res) => {
    const reference = paramReference(req.params.reference);
    if (!reference) {
      sendError(res, 404, "NOT_FOUND", "Activity not found.");
      return;
    }

    const parsed = correctCompletionBody.safeParse(req.body);
    if (!parsed.success) {
      sendError(
        res,
        400,
        "VALIDATION_FAILED",
        "Enter the corrected completion date, time, notes, reason, and confirmation.",
      );
      return;
    }

    const body = parsed.data;
    const requestKey = extractRequestKey(body.requestKey, req);
    if (!requestKey || requestKey.length > 128) {
      sendError(res, 400, "VALIDATION_FAILED", "A correction request key is required.");
      return;
    }

    const confirmed = body.confirmed ?? body.confirmCompleted ?? false;
    if (confirmed !== true) {
      sendError(res, 400, "VALIDATION_FAILED", "Confirm the corrected completion details before saving.");
      return;
    }

    const reason = (body.reason ?? "").trim();
    if (!reason) {
      sendError(res, 400, "VALIDATION_FAILED", "Enter a reason for correcting completion details.");
      return;
    }

    const completionNotes = normalizeNotes(body.completionNotes, body.notes);
    if (!completionNotes) {
      sendError(res, 400, "VALIDATION_FAILED", "Enter completion notes before saving.");
      return;
    }

    const actualCompletedAt = parseManilaDateTimeInput({
      date: body.completedDate,
      time: body.completedTime,
      iso: body.actualCompletedAt ?? body.completedAt,
    });
    if (!actualCompletedAt) {
      sendError(res, 400, "VALIDATION_FAILED", "Enter a valid completion date and time.");
      return;
    }

    if (actualCompletedAt.getTime() > req.now.getTime()) {
      sendError(res, 400, "VALIDATION_FAILED", "Completion time cannot be in the future.");
      return;
    }

    const fingerprint = JSON.stringify({
      targetReference: reference,
      expectedVersion: body.expectedVersion,
      actualCompletedAt: actualCompletedAt.toISOString(),
      completionNotes,
      reason,
    });

    const outcome = await db.transaction(async (tx) => {
      await repo.lockForSchedule(tx);

      const existingReq = await repo.findMutationRequestByKey(tx, requestKey);
      if (existingReq) {
        if (
          existingReq.operation !== "CORRECT_COMPLETION" ||
          existingReq.targetReference !== reference ||
          existingReq.payloadFingerprint !== fingerprint
        ) {
          return { kind: "key-conflict" as const };
        }
        const row = await repo.findByReference(tx, reference);
        if (!row) return { kind: "not-found" as const };
        const [activity] = await hydrateViews(tx, [row], req.now);
        return { kind: "replayed" as const, activity: activity! };
      }

      const target = await repo.findByReference(tx, reference);
      if (!target) {
        return { kind: "not-found" as const };
      }
      if (target.cancelledAt !== null) {
        return { kind: "already-cancelled" as const };
      }
      if (target.actualCompletedAt === null || target.completionNotes === null) {
        return { kind: "not-completed" as const };
      }
      if (target.version !== body.expectedVersion) {
        return { kind: "stale-activity" as const };
      }

      await repo.correctCompletion(tx, {
        occurrenceId: target.id,
        requestKey,
        previousActualCompletedAt: toDate(target.actualCompletedAt),
        newActualCompletedAt: actualCompletedAt,
        previousCompletionNotes: target.completionNotes,
        newCompletionNotes: completionNotes,
        reason,
        correctedByUserId: req.auth!.user.id,
        correctedAt: req.now,
      });

      await repo.insertMutationRequest(tx, {
        requestKey,
        operation: "CORRECT_COMPLETION",
        targetReference: reference,
        scope: "THIS_OCCURRENCE",
        payloadFingerprint: fingerprint,
        responseStatus: 200,
        affectedReferences: [reference],
        createdByUserId: req.auth!.user.id,
        createdAt: req.now,
      });

      const updated = await repo.findByReference(tx, reference);
      const [activity] = await hydrateViews(tx, [updated!], req.now);
      return { kind: "updated" as const, activity: activity! };
    });

    if (outcome.kind === "not-found") {
      sendError(res, 404, "NOT_FOUND", "Activity not found.");
      return;
    }
    if (outcome.kind === "already-cancelled") {
      sendError(res, 409, "ACTIVITY_ALREADY_CANCELLED", "Cancelled activities cannot be corrected.");
      return;
    }
    if (outcome.kind === "not-completed") {
      sendError(res, 409, "ACTIVITY_NOT_COMPLETED", "Only completed activities can have completion details corrected.");
      return;
    }
    if (outcome.kind === "stale-activity") {
      sendError(
        res,
        409,
        "STALE_ACTIVITY",
        "This activity changed while you were correcting completion details. Reload and review the latest record.",
      );
      return;
    }
    if (outcome.kind === "key-conflict") {
      sendError(
        res,
        409,
        "REQUEST_KEY_CONFLICT",
        "This correction key was already used for a different request.",
      );
      return;
    }

    res.status(200).json({ ...outcome.activity, activity: outcome.activity, replayed: outcome.kind === "replayed" });
  });

  router.get("/reminders", async (req, res) => {
    const { nowUtc, upcomingCutoffUtc } = manilaReminderWindow(req.now);
    const rows = await repo.listUnfinishedBeforeCutoff(db, upcomingCutoffUtc);

    let upcomingCount = 0;
    let overdueCount = 0;
    const items: ReminderItem[] = rows.map((row) => {
      const scheduledAt = toDate(row.scheduledAt);
      const isOverdue = scheduledAt.getTime() < nowUtc.getTime();
      if (isOverdue) {
        overdueCount += 1;
      } else {
        upcomingCount += 1;
      }
      return {
        reference: row.reference,
        name: row.name,
        scheduledAt: formatManilaIso(scheduledAt),
        scheduledDate: formatManilaDate(scheduledAt),
        scheduledTime: formatManilaTime(scheduledAt),
        scheduleNotes: row.scheduleNotes,
        status: isOverdue ? "OVERDUE" : "UPCOMING",
      };
    });

    res.json({ upcomingCount, overdueCount, items });
  });

  return router;
}
