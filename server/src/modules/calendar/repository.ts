import type { Queryable } from "../../db/database.js";
import {
  type ActivityChangeView,
  type ActivityCompletionCorrectionView,
  type ActivityEditScope,
  type ActivitySeriesSummary,
  type ActivityView,
  type RecurrenceRule,
  deriveActivityStatus,
  formatManilaDate,
  formatManilaIso,
  formatManilaTime,
} from "./calendar.js";

export interface OccurrenceDbRow {
  id: string;
  reference: string;
  version: number;
  requestKey: string | null;
  name: string;
  scheduledAt: Date | string;
  scheduleNotes: string | null;
  originalName: string;
  originalScheduledAt: Date | string;
  originalScheduleNotes: string | null;
  cancelledAt: Date | string | null;
  cancelledByUsername: string | null;
  cancellationReason: string | null;
  seriesId: string | null;
  seriesReference: string | null;
  seriesRecurrence: Exclude<RecurrenceRule, "ONE_TIME"> | null;
  seriesEndDate: string | null;
  seriesIndex: number | null;
  createdByUsername: string;
  createdAt: Date | string;
  actualCompletedAt: Date | string | null;
  completionNotes: string | null;
  originalActualCompletedAt: Date | string | null;
  originalCompletionNotes: string | null;
  recordedByUsername: string | null;
  recordedAt: Date | string | null;
}

export interface CompletionCorrectionDbRow {
  id: string;
  occurrenceId: string;
  previousActualCompletedAt: Date | string;
  newActualCompletedAt: Date | string;
  previousCompletionNotes: string;
  newCompletionNotes: string;
  reason: string;
  correctedByUsername: string;
  correctedAt: Date | string;
}

export interface OccurrenceChangeDbRow {
  id: string;
  occurrenceId: string;
  changeType: "EDIT" | "CANCEL";
  scope: ActivityEditScope;
  previousName: string;
  newName: string;
  previousScheduledAt: Date | string;
  newScheduledAt: Date | string;
  previousScheduleNotes: string | null;
  newScheduleNotes: string | null;
  reason: string | null;
  changedByUsername: string;
  changedAt: Date | string;
}

export interface ScheduleRequestDbRow {
  requestKey: string;
  recurrence: RecurrenceRule;
  name: string;
  scheduledAt: Date | string;
  endDate: string | null;
  scheduleNotes: string | null;
  seriesId: string | null;
  occurrenceReferences: string[];
}

export interface MutationRequestDbRow {
  requestKey: string;
  operation: "EDIT" | "CANCEL" | "CORRECT_COMPLETION";
  targetReference: string;
  scope: ActivityEditScope;
  payloadFingerprint: string;
  responseStatus: number;
  affectedReferences: string[];
}

export interface SeriesDbRow {
  id: string;
  reference: string;
  recurrence: Exclude<RecurrenceRule, "ONE_TIME">;
  startDate: string;
  endDate: string;
  scheduledTime: string;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toChangeView(row: OccurrenceChangeDbRow): ActivityChangeView {
  const prevAt = toDate(row.previousScheduledAt);
  const nextAt = toDate(row.newScheduledAt);
  const changedAt = toDate(row.changedAt);
  return {
    id: row.id,
    changeType: row.changeType,
    scope: row.scope,
    previousName: row.previousName,
    newName: row.newName,
    previousScheduledAt: formatManilaIso(prevAt),
    previousScheduledDate: formatManilaDate(prevAt),
    previousScheduledTime: formatManilaTime(prevAt),
    newScheduledAt: formatManilaIso(nextAt),
    newScheduledDate: formatManilaDate(nextAt),
    newScheduledTime: formatManilaTime(nextAt),
    previousScheduleNotes: row.previousScheduleNotes,
    newScheduleNotes: row.newScheduleNotes,
    reason: row.reason,
    changedBy: row.changedByUsername,
    changedAt: formatManilaIso(changedAt),
  };
}

function toCorrectionView(row: CompletionCorrectionDbRow): ActivityCompletionCorrectionView {
  const prevAt = toDate(row.previousActualCompletedAt);
  const nextAt = toDate(row.newActualCompletedAt);
  const correctedAt = toDate(row.correctedAt);
  return {
    id: row.id,
    previousActualCompletedAt: formatManilaIso(prevAt),
    previousCompletedDate: formatManilaDate(prevAt),
    previousCompletedTime: formatManilaTime(prevAt),
    previousCompletionNotes: row.previousCompletionNotes,
    newActualCompletedAt: formatManilaIso(nextAt),
    newCompletedDate: formatManilaDate(nextAt),
    newCompletedTime: formatManilaTime(nextAt),
    newCompletionNotes: row.newCompletionNotes,
    reason: row.reason,
    correctedBy: row.correctedByUsername,
    correctedAt: formatManilaIso(correctedAt),
  };
}

export function toActivityView(
  row: OccurrenceDbRow,
  now: Date,
  scheduleHistory: ActivityChangeView[] = [],
  completionCorrections: ActivityCompletionCorrectionView[] = [],
): ActivityView {
  const scheduledAt = toDate(row.scheduledAt);
  const originalScheduledAt = toDate(row.originalScheduledAt);
  const createdAt = toDate(row.createdAt);
  const cancelled = row.cancelledAt !== null && row.cancellationReason !== null;
  const completed =
    !cancelled &&
    row.actualCompletedAt !== null &&
    row.completionNotes !== null &&
    row.recordedAt !== null;

  let completion: ActivityView["completion"] = null;
  if (completed) {
    const actualAt = toDate(row.actualCompletedAt!);
    const originalActualAt = toDate(row.originalActualCompletedAt ?? row.actualCompletedAt!);
    const recordedAt = toDate(row.recordedAt!);
    completion = {
      actualCompletedAt: formatManilaIso(actualAt),
      completedDate: formatManilaDate(actualAt),
      completedTime: formatManilaTime(actualAt),
      notes: row.completionNotes!,
      completionNotes: row.completionNotes!,
      recordedBy: row.recordedByUsername!,
      recordedAt: formatManilaIso(recordedAt),
      originalActualCompletedAt: formatManilaIso(originalActualAt),
      originalCompletedDate: formatManilaDate(originalActualAt),
      originalCompletedTime: formatManilaTime(originalActualAt),
      originalCompletionNotes: row.originalCompletionNotes ?? row.completionNotes!,
      corrections: completionCorrections,
    };
  }

  const cancellation = cancelled
    ? {
      reason: row.cancellationReason!,
      cancelledBy: row.cancelledByUsername!,
      cancelledAt: formatManilaIso(toDate(row.cancelledAt!)),
    }
    : null;

  return {
    reference: row.reference,
    version: row.version,
    name: row.name,
    scheduledAt: formatManilaIso(scheduledAt),
    scheduledDate: formatManilaDate(scheduledAt),
    scheduledTime: formatManilaTime(scheduledAt),
    scheduleNotes: row.scheduleNotes,
    originalName: row.originalName,
    originalScheduledAt: formatManilaIso(originalScheduledAt),
    originalScheduledDate: formatManilaDate(originalScheduledAt),
    originalScheduledTime: formatManilaTime(originalScheduledAt),
    originalScheduleNotes: row.originalScheduleNotes,
    status: deriveActivityStatus(scheduledAt, completed, now, cancelled),
    recurrence: row.seriesRecurrence ?? "ONE_TIME",
    seriesReference: row.seriesReference ?? null,
    seriesIndex: row.seriesIndex ?? null,
    seriesEndDate: row.seriesEndDate ?? null,
    cancellation,
    scheduleHistory,
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

export function toSeriesSummary(
  series: SeriesDbRow | null,
  occurrenceReferences: string[],
): ActivitySeriesSummary | null {
  if (!series) return null;
  return {
    reference: series.reference,
    recurrence: series.recurrence,
    startDate: series.startDate,
    endDate: series.endDate,
    scheduledTime: series.scheduledTime,
    occurrenceCount: occurrenceReferences.length,
    occurrenceReferences,
  };
}

const OCCURRENCE_SELECT = `
  SELECT o.id,
         o.reference,
         o.version,
         o.request_key AS "requestKey",
         o.name,
         o.scheduled_at AS "scheduledAt",
         o.schedule_notes AS "scheduleNotes",
         o.original_name AS "originalName",
         o.original_scheduled_at AS "originalScheduledAt",
         o.original_schedule_notes AS "originalScheduleNotes",
         o.cancelled_at AS "cancelledAt",
         canceller.username AS "cancelledByUsername",
         o.cancellation_reason AS "cancellationReason",
         o.series_id AS "seriesId",
         s.reference AS "seriesReference",
         s.recurrence AS "seriesRecurrence",
         s.end_date::text AS "seriesEndDate",
         o.series_index AS "seriesIndex",
         creator.username AS "createdByUsername",
         o.created_at AS "createdAt",
         c.actual_completed_at AS "actualCompletedAt",
         c.completion_notes AS "completionNotes",
         c.original_actual_completed_at AS "originalActualCompletedAt",
         c.original_completion_notes AS "originalCompletionNotes",
         recorder.username AS "recordedByUsername",
         c.recorded_at AS "recordedAt"
    FROM calendar_occurrences o
    JOIN app_users creator ON creator.id = o.created_by_user_id
    LEFT JOIN app_users canceller ON canceller.id = o.cancelled_by_user_id
    LEFT JOIN calendar_series s ON s.id = o.series_id
    LEFT JOIN calendar_completions c ON c.occurrence_id = o.id
    LEFT JOIN app_users recorder ON recorder.id = c.recorded_by_user_id`;

/** PostgreSQL persistence adapter for Calendar occurrences, series, history, and completions. */
export const calendarRepository = {
  async lockForSchedule(tx: Queryable): Promise<void> {
    await tx.query("LOCK TABLE calendar_occurrences IN SHARE ROW EXCLUSIVE MODE");
  },

  async findScheduleRequestByKey(db: Queryable, requestKey: string): Promise<ScheduleRequestDbRow | undefined> {
    const { rows } = await db.query<ScheduleRequestDbRow>(
      `SELECT request_key AS "requestKey",
              recurrence,
              name,
              scheduled_at AS "scheduledAt",
              end_date::text AS "endDate",
              schedule_notes AS "scheduleNotes",
              series_id AS "seriesId",
              occurrence_references AS "occurrenceReferences"
         FROM calendar_schedule_requests
        WHERE request_key = $1`,
      [requestKey],
    );
    return rows[0];
  },

  async findMutationRequestByKey(db: Queryable, requestKey: string): Promise<MutationRequestDbRow | undefined> {
    const { rows } = await db.query<MutationRequestDbRow>(
      `SELECT request_key AS "requestKey",
              operation,
              target_reference AS "targetReference",
              scope,
              payload_fingerprint AS "payloadFingerprint",
              response_status AS "responseStatus",
              affected_references AS "affectedReferences"
         FROM calendar_mutation_requests
        WHERE request_key = $1`,
      [requestKey],
    );
    return rows[0];
  },

  async findSeriesById(db: Queryable, seriesId: string): Promise<SeriesDbRow | undefined> {
    const { rows } = await db.query<SeriesDbRow>(
      `SELECT id,
              reference,
              recurrence,
              start_date::text AS "startDate",
              end_date::text AS "endDate",
              scheduled_time AS "scheduledTime"
         FROM calendar_series
        WHERE id = $1`,
      [seriesId],
    );
    return rows[0];
  },

  async findSeriesOccurrences(db: Queryable, seriesId: string): Promise<OccurrenceDbRow[]> {
    const { rows } = await db.query<OccurrenceDbRow>(
      `${OCCURRENCE_SELECT}
        WHERE o.series_id = $1
        ORDER BY o.series_index ASC, o.scheduled_at ASC, o.reference ASC`,
      [seriesId],
    );
    return rows;
  },

  async findByRequestKey(db: Queryable, requestKey: string): Promise<OccurrenceDbRow | undefined> {
    const { rows } = await db.query<OccurrenceDbRow>(`${OCCURRENCE_SELECT} WHERE o.request_key = $1`, [requestKey]);
    return rows[0];
  },

  async findByReference(db: Queryable, reference: string): Promise<OccurrenceDbRow | undefined> {
    const { rows } = await db.query<OccurrenceDbRow>(`${OCCURRENCE_SELECT} WHERE o.reference = $1`, [reference]);
    return rows[0];
  },

  async findByReferences(db: Queryable, references: string[]): Promise<OccurrenceDbRow[]> {
    if (references.length === 0) return [];
    const { rows } = await db.query<OccurrenceDbRow>(
      `${OCCURRENCE_SELECT} WHERE o.reference = ANY($1::text[])`,
      [references],
    );
    const byRef = new Map(rows.map((row) => [row.reference, row]));
    return references.map((ref) => byRef.get(ref)).filter((row): row is OccurrenceDbRow => row !== undefined);
  },

  async loadChangesByOccurrenceIds(
    db: Queryable,
    occurrenceIds: string[],
  ): Promise<Map<string, ActivityChangeView[]>> {
    const map = new Map<string, ActivityChangeView[]>();
    if (occurrenceIds.length === 0) return map;
    const uniqueIds = Array.from(new Set(occurrenceIds));
    const { rows } = await db.query<OccurrenceChangeDbRow>(
      `SELECT ch.id,
              ch.occurrence_id AS "occurrenceId",
              ch.change_type AS "changeType",
              ch.scope,
              ch.previous_name AS "previousName",
              ch.new_name AS "newName",
              ch.previous_scheduled_at AS "previousScheduledAt",
              ch.new_scheduled_at AS "newScheduledAt",
              ch.previous_schedule_notes AS "previousScheduleNotes",
              ch.new_schedule_notes AS "newScheduleNotes",
              ch.reason,
              actor.username AS "changedByUsername",
              ch.changed_at AS "changedAt"
         FROM calendar_occurrence_changes ch
         JOIN app_users actor ON actor.id = ch.changed_by_user_id
        WHERE ch.occurrence_id = ANY($1::uuid[])
        ORDER BY ch.changed_at ASC, ch.id ASC`,
      [uniqueIds],
    );
    for (const row of rows) {
      const list = map.get(row.occurrenceId) ?? [];
      list.push(toChangeView(row));
      map.set(row.occurrenceId, list);
    }
    return map;
  },

  async loadCompletionCorrectionsByOccurrenceIds(
    db: Queryable,
    occurrenceIds: string[],
  ): Promise<Map<string, ActivityCompletionCorrectionView[]>> {
    const map = new Map<string, ActivityCompletionCorrectionView[]>();
    if (occurrenceIds.length === 0) return map;
    const uniqueIds = Array.from(new Set(occurrenceIds));
    const { rows } = await db.query<CompletionCorrectionDbRow>(
      `SELECT cc.id,
              cc.occurrence_id AS "occurrenceId",
              cc.previous_actual_completed_at AS "previousActualCompletedAt",
              cc.new_actual_completed_at AS "newActualCompletedAt",
              cc.previous_completion_notes AS "previousCompletionNotes",
              cc.new_completion_notes AS "newCompletionNotes",
              cc.reason,
              actor.username AS "correctedByUsername",
              cc.corrected_at AS "correctedAt"
         FROM calendar_completion_corrections cc
         JOIN app_users actor ON actor.id = cc.corrected_by_user_id
        WHERE cc.occurrence_id = ANY($1::uuid[])
        ORDER BY cc.resulting_version ASC, cc.corrected_at ASC, cc.id ASC`,
      [uniqueIds],
    );
    for (const row of rows) {
      const list = map.get(row.occurrenceId) ?? [];
      list.push(toCorrectionView(row));
      map.set(row.occurrenceId, list);
    }
    return map;
  },

  async findUnfinishedAtScheduledTime(db: Queryable, scheduledAt: Date): Promise<OccurrenceDbRow[]> {
    const { rows } = await db.query<OccurrenceDbRow>(
      `${OCCURRENCE_SELECT}
        WHERE o.cancelled_at IS NULL AND c.id IS NULL AND o.scheduled_at = $1
        ORDER BY o.created_at ASC, o.reference ASC`,
      [scheduledAt],
    );
    return rows;
  },

  async findUnfinishedAtScheduledTimes(db: Queryable, scheduledTimes: Date[]): Promise<OccurrenceDbRow[]> {
    if (scheduledTimes.length === 0) return [];
    const { rows } = await db.query<OccurrenceDbRow>(
      `${OCCURRENCE_SELECT}
        WHERE o.cancelled_at IS NULL AND c.id IS NULL AND o.scheduled_at = ANY($1::timestamptz[])
        ORDER BY o.scheduled_at ASC, o.created_at ASC, o.reference ASC`,
      [scheduledTimes.map((d) => d.toISOString())],
    );
    return rows;
  },

  async findUnfinishedAtScheduledTimesExcluding(
    db: Queryable,
    scheduledTimes: Date[],
    excludeIds: string[],
  ): Promise<OccurrenceDbRow[]> {
    if (scheduledTimes.length === 0) return [];
    const { rows } = await db.query<OccurrenceDbRow>(
      `${OCCURRENCE_SELECT}
        WHERE o.cancelled_at IS NULL
          AND c.id IS NULL
          AND o.scheduled_at = ANY($1::timestamptz[])
          AND NOT (o.id = ANY($2::uuid[]))
        ORDER BY o.scheduled_at ASC, o.created_at ASC, o.reference ASC`,
      [scheduledTimes.map((d) => d.toISOString()), excludeIds],
    );
    return rows;
  },

  async allocateReferencesForMonthDays(tx: Queryable, mmdds: string[]): Promise<string[]> {
    if (mmdds.length === 0) return [];
    const uniqueMmdds = Array.from(new Set(mmdds));
    const { rows } = await tx.query<{ reference: string }>(
      `SELECT reference
         FROM calendar_occurrences
        WHERE reference LIKE 'ACT-%-%'
          AND substring(reference from 5 for 4) = ANY($1::text[])`,
      [uniqueMmdds],
    );

    const maxSeqByMmdd = new Map<string, number>();
    for (const row of rows) {
      if (!row.reference.startsWith("ACT-") || row.reference[8] !== "-") continue;
      const mmdd = row.reference.slice(4, 8);
      const seq = Number(row.reference.slice(9));
      if (Number.isInteger(seq) && seq > (maxSeqByMmdd.get(mmdd) ?? 0)) {
        maxSeqByMmdd.set(mmdd, seq);
      }
    }

    const allocated: string[] = [];
    for (const mmdd of mmdds) {
      const nextSeq = (maxSeqByMmdd.get(mmdd) ?? 0) + 1;
      maxSeqByMmdd.set(mmdd, nextSeq);
      allocated.push(`ACT-${mmdd}-${String(nextSeq).padStart(2, "0")}`);
    }
    return allocated;
  },

  async nextSeriesReferenceForMonthDay(tx: Queryable, mmdd: string): Promise<string> {
    const prefix = `SER-${mmdd}-`;
    const { rows } = await tx.query<{ reference: string }>(
      `SELECT reference FROM calendar_series WHERE reference LIKE $1`,
      [`${prefix}%`],
    );
    let maxSeq = 0;
    for (const row of rows) {
      const seq = Number(row.reference.slice(prefix.length));
      if (Number.isInteger(seq) && seq > maxSeq) maxSeq = seq;
    }
    return `${prefix}${String(maxSeq + 1).padStart(2, "0")}`;
  },

  async insertSeries(
    tx: Queryable,
    input: {
      reference: string;
      recurrence: Exclude<RecurrenceRule, "ONE_TIME">;
      startDate: string;
      endDate: string;
      scheduledTime: string;
      preferredDayOfMonth: number | null;
      weekday: number | null;
      createdByUserId: string;
      createdAt: Date;
    },
  ): Promise<SeriesDbRow> {
    const { rows } = await tx.query<SeriesDbRow>(
      `INSERT INTO calendar_series
         (reference, recurrence, start_date, end_date, scheduled_time, preferred_day_of_month, weekday, created_by_user_id, created_at)
       VALUES ($1, $2, $3::date, $4::date, $5, $6, $7, $8, $9)
       RETURNING id,
                 reference,
                 recurrence,
                 start_date::text AS "startDate",
                 end_date::text AS "endDate",
                 scheduled_time AS "scheduledTime"`,
      [
        input.reference,
        input.recurrence,
        input.startDate,
        input.endDate,
        input.scheduledTime,
        input.preferredDayOfMonth,
        input.weekday,
        input.createdByUserId,
        input.createdAt,
      ],
    );
    return rows[0]!;
  },

  async insertOccurrences(
    tx: Queryable,
    input: {
      references: string[];
      scheduledTimes: Date[];
      requestKey: string | null;
      name: string;
      scheduleNotes: string | null;
      seriesId: string | null;
      createdByUserId: string;
      createdAt: Date;
    },
  ): Promise<void> {
    if (input.references.length === 0) return;
    await tx.query(
      `INSERT INTO calendar_occurrences
         (reference, request_key, name, scheduled_at, schedule_notes, original_name, original_scheduled_at, original_schedule_notes, series_id, series_index, created_by_user_id, created_at)
       SELECT t.reference,
              $3::text,
              $4::text,
              t.scheduled_at,
              $5::text,
              $4::text,
              t.scheduled_at,
              $5::text,
              $6::uuid,
              CASE WHEN $6::uuid IS NULL THEN NULL ELSE t.ord::integer END,
              $7::uuid,
              $8::timestamptz
         FROM unnest($1::text[], $2::timestamptz[]) WITH ORDINALITY AS t(reference, scheduled_at, ord)`,
      [
        input.references,
        input.scheduledTimes.map((d) => d.toISOString()),
        input.requestKey,
        input.name,
        input.scheduleNotes,
        input.seriesId,
        input.createdByUserId,
        input.createdAt,
      ],
    );
  },

  async insertScheduleRequest(
    tx: Queryable,
    input: {
      requestKey: string;
      recurrence: RecurrenceRule;
      name: string;
      scheduledAt: Date;
      endDate: string | null;
      scheduleNotes: string | null;
      seriesId: string | null;
      occurrenceReferences: string[];
      createdByUserId: string;
      createdAt: Date;
    },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO calendar_schedule_requests
         (request_key, recurrence, name, scheduled_at, end_date, schedule_notes, series_id, occurrence_references, created_by_user_id, created_at)
       VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8::jsonb, $9, $10)`,
      [
        input.requestKey,
        input.recurrence,
        input.name,
        input.scheduledAt,
        input.endDate,
        input.scheduleNotes,
        input.seriesId,
        JSON.stringify(input.occurrenceReferences),
        input.createdByUserId,
        input.createdAt,
      ],
    );
  },

  async insertMutationRequest(
    tx: Queryable,
    input: {
      requestKey: string;
      operation: "EDIT" | "CANCEL" | "CORRECT_COMPLETION";
      targetReference: string;
      scope: ActivityEditScope;
      payloadFingerprint: string;
      responseStatus: number;
      affectedReferences: string[];
      createdByUserId: string;
      createdAt: Date;
    },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO calendar_mutation_requests
         (request_key, operation, target_reference, scope, payload_fingerprint, response_status, affected_references, created_by_user_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
      [
        input.requestKey,
        input.operation,
        input.targetReference,
        input.scope,
        input.payloadFingerprint,
        input.responseStatus,
        JSON.stringify(input.affectedReferences),
        input.createdByUserId,
        input.createdAt,
      ],
    );
  },

  async updateOccurrencesSchedule(
    tx: Queryable,
    updates: Array<{
      id: string;
      name: string;
      scheduledAt: Date;
      scheduleNotes: string | null;
    }>,
  ): Promise<void> {
    if (updates.length === 0) return;
    await tx.query(
      `UPDATE calendar_occurrences o
          SET name = u.name,
              scheduled_at = u.scheduled_at,
              schedule_notes = u.schedule_notes,
              version = o.version + 1
         FROM unnest($1::uuid[], $2::text[], $3::timestamptz[], $4::text[])
           AS u(id, name, scheduled_at, schedule_notes)
        WHERE o.id = u.id`,
      [
        updates.map((u) => u.id),
        updates.map((u) => u.name),
        updates.map((u) => u.scheduledAt.toISOString()),
        updates.map((u) => u.scheduleNotes),
      ],
    );
  },

  async cancelOccurrences(
    tx: Queryable,
    input: {
      ids: string[];
      reason: string;
      cancelledByUserId: string;
      cancelledAt: Date;
    },
  ): Promise<void> {
    if (input.ids.length === 0) return;
    await tx.query(
      `UPDATE calendar_occurrences
          SET cancelled_at = $2,
              cancelled_by_user_id = $3,
              cancellation_reason = $4,
              version = version + 1
        WHERE id = ANY($1::uuid[])`,
      [input.ids, input.cancelledAt, input.cancelledByUserId, input.reason],
    );
  },

  async insertOccurrenceChanges(
    tx: Queryable,
    changes: Array<{
      occurrenceId: string;
      changeType: "EDIT" | "CANCEL";
      scope: ActivityEditScope;
      requestKey: string;
      previousName: string;
      newName: string;
      previousScheduledAt: Date;
      newScheduledAt: Date;
      previousScheduleNotes: string | null;
      newScheduleNotes: string | null;
      reason: string | null;
      changedByUserId: string;
      changedAt: Date;
    }>,
  ): Promise<void> {
    if (changes.length === 0) return;
    await tx.query(
      `INSERT INTO calendar_occurrence_changes
         (occurrence_id, change_type, scope, request_key, previous_name, new_name, previous_scheduled_at, new_scheduled_at, previous_schedule_notes, new_schedule_notes, reason, changed_by_user_id, changed_at)
       SELECT t.occurrence_id,
              t.change_type,
              t.scope,
              t.request_key,
              t.previous_name,
              t.new_name,
              t.previous_scheduled_at,
              t.new_scheduled_at,
              t.previous_schedule_notes,
              t.new_schedule_notes,
              t.reason,
              t.changed_by_user_id,
              t.changed_at
         FROM unnest(
           $1::uuid[],
           $2::text[],
           $3::text[],
           $4::text[],
           $5::text[],
           $6::text[],
           $7::timestamptz[],
           $8::timestamptz[],
           $9::text[],
           $10::text[],
           $11::text[],
           $12::uuid[],
           $13::timestamptz[]
         ) AS t(
           occurrence_id,
           change_type,
           scope,
           request_key,
           previous_name,
           new_name,
           previous_scheduled_at,
           new_scheduled_at,
           previous_schedule_notes,
           new_schedule_notes,
           reason,
           changed_by_user_id,
           changed_at
         )`,
      [
        changes.map((c) => c.occurrenceId),
        changes.map((c) => c.changeType),
        changes.map((c) => c.scope),
        changes.map((c) => c.requestKey),
        changes.map((c) => c.previousName),
        changes.map((c) => c.newName),
        changes.map((c) => c.previousScheduledAt.toISOString()),
        changes.map((c) => c.newScheduledAt.toISOString()),
        changes.map((c) => c.previousScheduleNotes),
        changes.map((c) => c.newScheduleNotes),
        changes.map((c) => c.reason),
        changes.map((c) => c.changedByUserId),
        changes.map((c) => c.changedAt.toISOString()),
      ],
    );
  },

  async lockOccurrenceForCompletion(
    tx: Queryable,
    reference: string,
  ): Promise<{ id: string; version: number; cancelledAt: Date | string | null } | undefined> {
    const { rows } = await tx.query<{ id: string; version: number; cancelledAt: Date | string | null }>(
      `SELECT id, version, cancelled_at AS "cancelledAt"
         FROM calendar_occurrences
        WHERE reference = $1
        FOR UPDATE`,
      [reference],
    );
    return rows[0];
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
  ): Promise<boolean> {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO calendar_completions
         (occurrence_id, actual_completed_at, completion_notes, original_actual_completed_at, original_completion_notes, recorded_by_user_id, recorded_at)
       VALUES ($1, $2, $3, $2, $3, $4, $5)
       ON CONFLICT (occurrence_id) DO NOTHING
       RETURNING id`,
      [
        input.occurrenceId,
        input.actualCompletedAt,
        input.completionNotes,
        input.recordedByUserId,
        input.recordedAt,
      ],
    );
    const inserted = rows.length > 0;
    if (inserted) {
      await tx.query(`UPDATE calendar_occurrences SET version = version + 1 WHERE id = $1`, [input.occurrenceId]);
    }
    return inserted;
  },

  async correctCompletion(
    tx: Queryable,
    input: {
      occurrenceId: string;
      requestKey: string;
      previousActualCompletedAt: Date;
      newActualCompletedAt: Date;
      previousCompletionNotes: string;
      newCompletionNotes: string;
      reason: string;
      correctedByUserId: string;
      correctedAt: Date;
    },
  ): Promise<void> {
    await tx.query(
      `UPDATE calendar_completions
          SET actual_completed_at = $2,
              completion_notes = $3
        WHERE occurrence_id = $1`,
      [input.occurrenceId, input.newActualCompletedAt, input.newCompletionNotes],
    );
    const { rows: versionRows } = await tx.query<{ version: number }>(
      `UPDATE calendar_occurrences
          SET version = version + 1
        WHERE id = $1
        RETURNING version`,
      [input.occurrenceId],
    );
    const resultingVersion = versionRows[0]!.version;
    await tx.query(
      `INSERT INTO calendar_completion_corrections
         (occurrence_id, resulting_version, request_key, previous_actual_completed_at, new_actual_completed_at, previous_completion_notes, new_completion_notes, reason, corrected_by_user_id, corrected_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        input.occurrenceId,
        resultingVersion,
        input.requestKey,
        input.previousActualCompletedAt,
        input.newActualCompletedAt,
        input.previousCompletionNotes,
        input.newCompletionNotes,
        input.reason,
        input.correctedByUserId,
        input.correctedAt,
      ],
    );
  },

  async listScheduledInWindow(db: Queryable, startUtc: Date, endUtc: Date): Promise<OccurrenceDbRow[]> {
    const { rows } = await db.query<OccurrenceDbRow>(
      `${OCCURRENCE_SELECT}
        WHERE o.cancelled_at IS NULL AND o.scheduled_at >= $1 AND o.scheduled_at < $2
        ORDER BY o.scheduled_at ASC, o.reference ASC`,
      [startUtc, endUtc],
    );
    return rows;
  },

  async listCompletedInWindow(db: Queryable, startUtc: Date, endUtc: Date): Promise<OccurrenceDbRow[]> {
    const { rows } = await db.query<OccurrenceDbRow>(
      `${OCCURRENCE_SELECT}
        WHERE o.cancelled_at IS NULL AND c.id IS NOT NULL AND c.actual_completed_at >= $1 AND c.actual_completed_at < $2
        ORDER BY c.actual_completed_at DESC, o.reference DESC`,
      [startUtc, endUtc],
    );
    return rows;
  },

  async listCancelledInWindow(db: Queryable, startUtc: Date, endUtc: Date): Promise<OccurrenceDbRow[]> {
    const { rows } = await db.query<OccurrenceDbRow>(
      `${OCCURRENCE_SELECT}
        WHERE o.cancelled_at IS NOT NULL AND o.scheduled_at >= $1 AND o.scheduled_at < $2
        ORDER BY o.scheduled_at ASC, o.reference ASC`,
      [startUtc, endUtc],
    );
    return rows;
  },

  async listUnfinishedBeforeCutoff(db: Queryable, cutoffUtc: Date): Promise<OccurrenceDbRow[]> {
    const { rows } = await db.query<OccurrenceDbRow>(
      `${OCCURRENCE_SELECT}
        WHERE o.cancelled_at IS NULL AND c.id IS NULL AND o.scheduled_at < $1
        ORDER BY o.scheduled_at ASC, o.reference ASC`,
      [cutoffUtc],
    );
    return rows;
  },
};
