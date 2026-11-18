import { Router } from "express";
import { z } from "zod";
import type { Database } from "../../db/database.js";
import { sendError } from "../../shared/http.js";
import { requireRole } from "../auth/guards.js";
import {
  calendarPermissions,
  conflictSetsEqual,
  formatManilaDate,
  formatManilaIso,
  formatManilaTime,
  manilaMonthDayCode,
  manilaReminderWindow,
  parseManilaDateTimeInput,
  parseManilaMonth,
  type ReminderItem,
} from "./calendar.js";
import { calendarRepository as repo, toActivityView } from "./repository.js";

const scheduleBody = z.object({
  name: z.string().trim().min(1, "Enter an activity name.").max(120),
  scheduledDate: z.string().optional(),
  scheduledTime: z.string().optional(),
  scheduledAt: z.string().optional(),
  scheduleNotes: z.string().max(1000).optional(),
  notes: z.string().max(1000).optional(),
  requestKey: z.string().trim().min(1).max(128).optional(),
  acknowledgedConflictReferences: z.array(z.string().trim().min(1)).optional(),
  confirmedConflictReferences: z.array(z.string().trim().min(1)).optional(),
});

const completionBody = z.object({
  completedDate: z.string().optional(),
  completedTime: z.string().optional(),
  completedAt: z.string().optional(),
  actualCompletedAt: z.string().optional(),
  completionNotes: z.string().max(1000).optional(),
  notes: z.string().max(1000).optional(),
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

    const [scheduledRows, completedRows] = await Promise.all([
      repo.listScheduledInWindow(db, window.startUtc, window.endUtc),
      repo.listCompletedInWindow(db, window.startUtc, window.endUtc),
    ]);

    res.json({
      month: window.month,
      scheduledActivities: scheduledRows.map((row) => toActivityView(row, req.now)),
      completedActivities: completedRows.map((row) => toActivityView(row, req.now)),
    });
  });

  router.get("/activities/:reference", async (req, res) => {
    const reference = paramReference(req.params.reference);
    if (!reference) {
      sendError(res, 404, "NOT_FOUND", "Activity not found.");
      return;
    }
    const row = await repo.findByReference(db, reference);
    if (!row) {
      sendError(res, 404, "NOT_FOUND", "Activity not found.");
      return;
    }
    const activity = toActivityView(row, req.now);
    res.json({ ...activity, activity });
  });

  router.post("/activities", requireRole("OWNER"), async (req, res) => {
    const parsed = scheduleBody.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_FAILED", "Enter the activity name, scheduled date, and scheduled time.");
      return;
    }

    const body = parsed.data;
    const requestKey = (body.requestKey ?? req.get("idempotency-key") ?? req.get("x-request-key") ?? "").trim();
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
    const acknowledgedRefs = body.acknowledgedConflictReferences ?? body.confirmedConflictReferences ?? [];

    const outcome = await db.transaction(async (tx) => {
      await repo.lockForSchedule(tx);

      const existing = await repo.findByRequestKey(tx, requestKey);
      if (existing) {
        const existingMs = (existing.scheduledAt instanceof Date ? existing.scheduledAt : new Date(existing.scheduledAt)).getTime();
        const matches =
          existing.name === body.name &&
          existingMs === scheduledAt.getTime() &&
          existing.scheduleNotes === scheduleNotes;
        if (!matches) {
          return { kind: "key-conflict" as const };
        }
        return { kind: "replayed" as const, row: existing };
      }

      const conflicts = await repo.findUnfinishedAtScheduledTime(tx, scheduledAt);
      const conflictReferences = conflicts.map((c) => c.reference);
      if (conflicts.length > 0 && !conflictSetsEqual(acknowledgedRefs, conflictReferences)) {
        return { kind: "schedule-conflict" as const, conflicts, conflictReferences };
      }

      const reference = await repo.nextReferenceForMonthDay(tx, manilaMonthDayCode(scheduledAt));
      await repo.insertOccurrence(tx, {
        reference,
        requestKey,
        name: body.name,
        scheduledAt,
        scheduleNotes,
        createdByUserId: req.auth!.user.id,
        createdAt: req.now,
      });
      const created = await repo.findByReference(tx, reference);
      return { kind: "created" as const, row: created! };
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
      const conflicts = outcome.conflicts.map((row) => toActivityView(row, req.now));
      res.status(409).json({
        error: {
          code: "SCHEDULE_CONFLICT",
          message: "Another unfinished activity is already scheduled at this date and time.",
        },
        conflicts,
        conflictReferences: outcome.conflictReferences,
      });
      return;
    }

    const activity = toActivityView(outcome.row, req.now);
    const replayed = outcome.kind === "replayed";
    res.status(replayed ? 200 : 201).json({ ...activity, activity, replayed });
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

    const updated = await db.transaction(async (tx) => {
      const occurrenceId = await repo.lockOccurrenceIdByReference(tx, reference);
      if (!occurrenceId) return undefined;

      await repo.insertCompletionIfAbsent(tx, {
        occurrenceId,
        actualCompletedAt,
        completionNotes,
        recordedByUserId: req.auth!.user.id,
        recordedAt: req.now,
      });
      return repo.findByReference(tx, reference);
    });

    if (!updated) {
      sendError(res, 404, "NOT_FOUND", "Activity not found.");
      return;
    }

    const activity = toActivityView(updated, req.now);
    res.status(200).json({ ...activity, activity });
  });

  router.get("/reminders", async (req, res) => {
    const { nowUtc, upcomingCutoffUtc } = manilaReminderWindow(req.now);
    const rows = await repo.listUnfinishedBeforeCutoff(db, upcomingCutoffUtc);

    let upcomingCount = 0;
    let overdueCount = 0;
    const items: ReminderItem[] = rows.map((row) => {
      const scheduledAt = row.scheduledAt instanceof Date ? row.scheduledAt : new Date(row.scheduledAt);
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
