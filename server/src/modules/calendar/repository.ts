import type { Queryable } from "../../db/database.js";
import {
  type ActivityView,
  deriveActivityStatus,
  formatManilaDate,
  formatManilaIso,
  formatManilaTime,
} from "./calendar.js";

export interface OccurrenceDbRow {
  id: string;
  reference: string;
  requestKey: string;
  name: string;
  scheduledAt: Date | string;
  scheduleNotes: string | null;
  createdByUsername: string;
  createdAt: Date | string;
  actualCompletedAt: Date | string | null;
  completionNotes: string | null;
  recordedByUsername: string | null;
  recordedAt: Date | string | null;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export function toActivityView(row: OccurrenceDbRow, now: Date): ActivityView {
  const scheduledAt = toDate(row.scheduledAt);
  const createdAt = toDate(row.createdAt);
  const completed = row.actualCompletedAt !== null && row.completionNotes !== null && row.recordedAt !== null;

  let completion: ActivityView["completion"] = null;
  if (completed) {
    const actualAt = toDate(row.actualCompletedAt!);
    const recordedAt = toDate(row.recordedAt!);
    completion = {
      actualCompletedAt: formatManilaIso(actualAt),
      completedDate: formatManilaDate(actualAt),
      completedTime: formatManilaTime(actualAt),
      notes: row.completionNotes!,
      completionNotes: row.completionNotes!,
      recordedBy: row.recordedByUsername!,
      recordedAt: formatManilaIso(recordedAt),
    };
  }

  return {
    reference: row.reference,
    name: row.name,
    scheduledAt: formatManilaIso(scheduledAt),
    scheduledDate: formatManilaDate(scheduledAt),
    scheduledTime: formatManilaTime(scheduledAt),
    scheduleNotes: row.scheduleNotes,
    status: deriveActivityStatus(scheduledAt, completed, now),
    createdBy: row.createdByUsername,
    createdAt: formatManilaIso(createdAt),
    actualCompletedAt: completion?.actualCompletedAt ?? null,
    completedDate: completion?.completedDate ?? null,
    completedTime: completion?.completedTime ?? null,
    completionNotes: completion?.completionNotes ?? null,
    recordedBy: completion?.recordedBy ?? null,
    recordedAt: completion?.recordedAt ?? null,
    completion,
  };
}

const OCCURRENCE_SELECT = `
  SELECT o.id,
         o.reference,
         o.request_key AS "requestKey",
         o.name,
         o.scheduled_at AS "scheduledAt",
         o.schedule_notes AS "scheduleNotes",
         creator.username AS "createdByUsername",
         o.created_at AS "createdAt",
         c.actual_completed_at AS "actualCompletedAt",
         c.completion_notes AS "completionNotes",
         recorder.username AS "recordedByUsername",
         c.recorded_at AS "recordedAt"
    FROM calendar_occurrences o
    JOIN app_users creator ON creator.id = o.created_by_user_id
    LEFT JOIN calendar_completions c ON c.occurrence_id = o.id
    LEFT JOIN app_users recorder ON recorder.id = c.recorded_by_user_id`;

/** PostgreSQL persistence adapter for Calendar occurrences and completions. */
export const calendarRepository = {
  async lockForSchedule(tx: Queryable): Promise<void> {
    await tx.query("LOCK TABLE calendar_occurrences IN SHARE ROW EXCLUSIVE MODE");
  },

  async findByRequestKey(db: Queryable, requestKey: string): Promise<OccurrenceDbRow | undefined> {
    const { rows } = await db.query<OccurrenceDbRow>(`${OCCURRENCE_SELECT} WHERE o.request_key = $1`, [requestKey]);
    return rows[0];
  },

  async findByReference(db: Queryable, reference: string): Promise<OccurrenceDbRow | undefined> {
    const { rows } = await db.query<OccurrenceDbRow>(`${OCCURRENCE_SELECT} WHERE o.reference = $1`, [reference]);
    return rows[0];
  },

  async findUnfinishedAtScheduledTime(db: Queryable, scheduledAt: Date): Promise<OccurrenceDbRow[]> {
    const { rows } = await db.query<OccurrenceDbRow>(
      `${OCCURRENCE_SELECT}
        WHERE c.id IS NULL AND o.scheduled_at = $1
        ORDER BY o.created_at ASC, o.reference ASC`,
      [scheduledAt],
    );
    return rows;
  },

  async nextReferenceForMonthDay(tx: Queryable, mmdd: string): Promise<string> {
    const prefix = `ACT-${mmdd}-`;
    const { rows } = await tx.query<{ reference: string }>(
      `SELECT reference FROM calendar_occurrences WHERE reference LIKE $1`,
      [`${prefix}%`],
    );
    let maxSeq = 0;
    for (const row of rows) {
      const seq = Number(row.reference.slice(prefix.length));
      if (Number.isInteger(seq) && seq > maxSeq) maxSeq = seq;
    }
    return `${prefix}${String(maxSeq + 1).padStart(2, "0")}`;
  },

  async insertOccurrence(
    tx: Queryable,
    input: {
      reference: string;
      requestKey: string;
      name: string;
      scheduledAt: Date;
      scheduleNotes: string | null;
      createdByUserId: string;
      createdAt: Date;
    },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO calendar_occurrences
         (reference, request_key, name, scheduled_at, schedule_notes, created_by_user_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.reference,
        input.requestKey,
        input.name,
        input.scheduledAt,
        input.scheduleNotes,
        input.createdByUserId,
        input.createdAt,
      ],
    );
  },

  async lockOccurrenceIdByReference(tx: Queryable, reference: string): Promise<string | undefined> {
    const { rows } = await tx.query<{ id: string }>(
      `SELECT id FROM calendar_occurrences WHERE reference = $1 FOR UPDATE`,
      [reference],
    );
    return rows[0]?.id;
  },

  async insertCompletionIfAbsent(
    tx: Queryable,
    input: {
      occurrenceId: string;
      actualCompletedAt: Date;
      completionNotes: string;
      recordedByUserId: string;
      recordedAt: Date;
    },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO calendar_completions
         (occurrence_id, actual_completed_at, completion_notes, recorded_by_user_id, recorded_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (occurrence_id) DO NOTHING`,
      [
        input.occurrenceId,
        input.actualCompletedAt,
        input.completionNotes,
        input.recordedByUserId,
        input.recordedAt,
      ],
    );
  },

  async listScheduledInWindow(db: Queryable, startUtc: Date, endUtc: Date): Promise<OccurrenceDbRow[]> {
    const { rows } = await db.query<OccurrenceDbRow>(
      `${OCCURRENCE_SELECT}
        WHERE o.scheduled_at >= $1 AND o.scheduled_at < $2
        ORDER BY o.scheduled_at ASC, o.reference ASC`,
      [startUtc, endUtc],
    );
    return rows;
  },

  async listCompletedInWindow(db: Queryable, startUtc: Date, endUtc: Date): Promise<OccurrenceDbRow[]> {
    const { rows } = await db.query<OccurrenceDbRow>(
      `${OCCURRENCE_SELECT}
        WHERE c.id IS NOT NULL AND c.actual_completed_at >= $1 AND c.actual_completed_at < $2
        ORDER BY c.actual_completed_at DESC, o.reference DESC`,
      [startUtc, endUtc],
    );
    return rows;
  },

  async listUnfinishedBeforeCutoff(db: Queryable, cutoffUtc: Date): Promise<OccurrenceDbRow[]> {
    const { rows } = await db.query<OccurrenceDbRow>(
      `${OCCURRENCE_SELECT}
        WHERE c.id IS NULL AND o.scheduled_at < $1
        ORDER BY o.scheduled_at ASC, o.reference ASC`,
      [cutoffUtc],
    );
    return rows;
  },
};
