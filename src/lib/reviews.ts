import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { CardInput } from "ts-fsrs";
import type { CardContent } from "./card-contracts";
import {
  ReviewError,
  type Direction,
  type Grade,
  type Today,
} from "./review-contracts";
import {
  automaticRating,
  emptySchedule,
  exactAnswer,
  localDay,
  reviewSides,
  scheduleReview,
  SCHEDULER_PARAMETERS,
  SCHEDULER_VERSION,
} from "./scheduler";

type Item = {
  id: string;
  session_id: string;
  card_id: string;
  card_version: number;
  direction: Direction;
  schedule_revision: number;
  available_at: Date;
  answer: string | null;
  grade: Grade | null;
  revealed: boolean;
  status: string;
  result: { decision: string; dueAt?: string } | null;
  content: CardContent;
};
async function transaction<T>(
  db: Pool,
  owner: string,
  run: (c: PoolClient) => Promise<T>,
) {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    // Share the vocabulary lock: edits, archive/delete and finalization cannot race.
    await c.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,7422026))",
      [owner],
    );
    const value = await run(c);
    await c.query("COMMIT");
    return value;
  } catch (error) {
    await c.query("ROLLBACK");
    throw error;
  } finally {
    c.release();
  }
}
async function prune(c: PoolClient, owner: string, now: Date) {
  await c.query(
    `UPDATE review_items i SET status='skipped'
    FROM review_sessions s, cards c WHERE i.session_id=s.id AND s.owner_id=$1
    AND i.card_id=c.id AND i.status='pending'
    AND (c.status<>'active' OR c.current_version<>i.card_version
      OR NOT EXISTS (SELECT 1 FROM review_schedules r WHERE r.card_id=i.card_id
        AND r.direction=i.direction AND r.revision=i.schedule_revision)
      OR EXISTS (SELECT 1 FROM review_events e JOIN owner_preferences p ON p.owner_id=e.owner_id
        WHERE e.card_id=i.card_id AND e.owner_id=$1
        AND (e.reviewed_at AT TIME ZONE p.timezone)::date=($2::timestamptz AT TIME ZONE p.timezone)::date))`,
    [owner, now],
  );
  await c.query(
    `UPDATE review_sessions s SET active=false WHERE owner_id=$1 AND active
    AND NOT EXISTS (SELECT 1 FROM review_items i WHERE i.session_id=s.id AND i.status='pending')`,
    [owner],
  );
}
async function ensureSchedules(c: PoolClient, owner: string, now: Date) {
  await c.query(
    `INSERT INTO review_schedules(card_id,direction,due_at,state)
    SELECT c.id,d.direction,c.created_at,$2::jsonb FROM cards c
    CROSS JOIN (VALUES ('ru-en'),('en-ru')) d(direction) WHERE c.owner_id=$1
    ON CONFLICT DO NOTHING`,
    [owner, JSON.stringify(emptySchedule(now))],
  );
}
async function item(c: PoolClient, owner: string, id: string): Promise<Item> {
  const rows = await c.query(
    `SELECT i.*, json_build_object('russian',v.russian,'english',v.english,
    'sense',v.sense,'context',v.context,'note',v.note) AS content
    FROM review_items i JOIN review_sessions s ON s.id=i.session_id
    JOIN card_versions v ON v.card_id=i.card_id AND v.version=i.card_version
    WHERE s.owner_id=$1 AND i.id=$2`,
    [owner, id],
  );
  if (!rows.rows[0])
    throw new ReviewError(
      404,
      "not_found",
      "This review is no longer available.",
    );
  return rows.rows[0];
}
async function validItem(c: PoolClient, owner: string, id: string, now: Date) {
  // Also discard same-day repeats saved by the previous quiz policy.
  await prune(c, owner, now);
  const found = await item(c, owner, id);
  const valid = await c.query(
    `SELECT 1 FROM cards c JOIN review_schedules r ON r.card_id=c.id
    JOIN review_sessions s ON s.id=$6 WHERE c.id=$1 AND c.owner_id=$2
    AND c.status='active' AND c.current_version=$3 AND r.direction=$4 AND r.revision=$5 AND s.active`,
    [
      found.card_id,
      owner,
      found.card_version,
      found.direction,
      found.schedule_revision,
      found.session_id,
    ],
  );
  if (found.status !== "pending" || !valid.rowCount)
    throw new ReviewError(
      409,
      "stale_review",
      "This review changed. Reload Today; no additional schedule change was made.",
    );
  if (found.available_at > now)
    throw new ReviewError(
      409,
      "not_due",
      "This card is not due yet. You can pause and return later.",
    );
  // Only the frozen queue head can be checked, even if a client knows another item ID.
  const head = await c.query(
    `SELECT id FROM review_items WHERE session_id=$1 AND status='pending' ORDER BY position LIMIT 1`,
    [found.session_id],
  );
  if (head.rows[0]?.id !== id)
    throw new ReviewError(
      409,
      "queue_order",
      "Continue the current question first.",
    );
  return found;
}
async function preferences(c: PoolClient, owner: string) {
  const result = await c.query(
    "SELECT timezone FROM owner_preferences WHERE owner_id=$1",
    [owner],
  );
  if (!result.rows[0])
    throw new ReviewError(404, "owner", "Owner preferences are unavailable.");
  return result.rows[0] as { timezone: string };
}
// A finalized answer retires the whole card for this day, not just one direction.
// Use the same filter for counts and selection so an empty queue really is empty.
const notAnsweredToday = `NOT EXISTS (SELECT 1 FROM review_events e
  WHERE e.owner_id=$1 AND e.card_id=c.id
  AND (e.reviewed_at AT TIME ZONE $4)::date=$3::date)`;
export async function getToday(
  db: Pool,
  owner: string,
  now = new Date(),
): Promise<Today> {
  return transaction(db, owner, async (c) => {
    await ensureSchedules(c, owner, now);
    await prune(c, owner, now);
    const p = await preferences(c, owner);
    const day = localDay(now, p.timezone);
    const progress = await c.query(
      `SELECT count(DISTINCT card_id)::int AS completed, count(*)::int AS attempts
      FROM review_events WHERE owner_id=$1 AND (reviewed_at AT TIME ZONE $2)::date=$3::date`,
      [owner, p.timezone, day],
    );
    const due = await c.query(
      `SELECT count(DISTINCT c.id)::int AS cards,count(*)::int AS directions
      FROM review_schedules r JOIN cards c ON c.id=r.card_id
      WHERE c.owner_id=$1 AND c.status='active' AND r.due_at<=$2 AND ${notAnsweredToday}`,
      [owner, now, day, p.timezone],
    );
    const totalCards = await c.query(
      "SELECT count(*)::int AS total FROM cards WHERE owner_id=$1 AND status='active'",
      [owner],
    );
    const active = await c.query(
      "SELECT id FROM review_sessions WHERE owner_id=$1 AND active",
      [owner],
    );
    let session: Today["session"] = null;
    if (active.rows[0]) {
      const id = active.rows[0].id;
      const pending = await c.query(
        "SELECT id,count(*) OVER()::int AS remaining FROM review_items WHERE session_id=$1 AND status='pending' ORDER BY position LIMIT 1",
        [id],
      );
      if (pending.rows[0]) {
        const i = await item(c, owner, pending.rows[0].id);
        const sides = reviewSides(i.content, i.direction);
        session = {
          id,
          remaining: pending.rows[0].remaining,
          item: {
            id: i.id,
            cardId: i.card_id,
            direction: i.direction,
            prompt: sides.prompt,
            sense: i.content.sense,
            context: i.content.context,
            answer: i.answer,
            reference: i.grade || i.revealed ? sides.reference : null,
            grade: i.grade,
            availableAt: i.available_at.toISOString(),
          },
        };
      }
    }
    return {
      timezone: p.timezone,
      day,
      ...progress.rows[0],
      dueCards: due.rows[0].cards,
      dueDirections: due.rows[0].directions,
      totalCards: totalCards.rows[0].total,
      session,
    };
  });
}
export async function startReview(db: Pool, owner: string, now = new Date()) {
  await transaction(db, owner, async (c) => {
    await ensureSchedules(c, owner, now);
    await prune(c, owner, now);
    if (
      (
        await c.query(
          "SELECT 1 FROM review_sessions WHERE owner_id=$1 AND active",
          [owner],
        )
      ).rowCount
    )
      return;
    const p = await preferences(c, owner);
    // Keep direction-specific schedules, but challenge each eligible card only once.
    // Retry a missed direction before an untouched opposite direction.
    const missed = `(SELECT e.rating='again' FROM review_events e
      WHERE e.card_id=c.id AND e.direction=r.direction
      ORDER BY e.reviewed_at DESC,e.attempt_id DESC LIMIT 1)`;
    const candidates = await c.query(
      `WITH ranked AS (
      SELECT c.id,c.current_version,r.direction,r.revision,r.due_at,
        CASE WHEN ${missed} OR (r.state->>'state')::int IN (1,3) THEN 0
          WHEN EXISTS(SELECT 1 FROM review_introductions x WHERE x.card_id=c.id) THEN 1 ELSE 2 END AS priority,
        row_number() OVER(PARTITION BY c.id ORDER BY
          CASE WHEN ${missed} OR (r.state->>'state')::int IN (1,3) THEN 0 ELSE 1 END,r.due_at,
          CASE WHEN r.direction=CASE WHEN mod(abs(hashtextextended(c.id::text || $3,0)::numeric),2)=0 THEN 'ru-en' ELSE 'en-ru' END THEN 0 ELSE 1 END) AS rank
      FROM cards c JOIN review_schedules r ON r.card_id=c.id
      WHERE c.owner_id=$1 AND c.status='active' AND r.due_at<=$2 AND ${notAnsweredToday})
      SELECT * FROM ranked WHERE rank=1 ORDER BY priority,due_at,id`,
      [owner, now, localDay(now, p.timezone), p.timezone],
    );
    const selected = candidates.rows;
    if (!selected.length) return;
    const sessionId = randomUUID();
    await c.query(
      "INSERT INTO review_sessions(id,owner_id,created_at) VALUES($1,$2,$3)",
      [sessionId, owner, now],
    );
    for (const [position, r] of selected.entries()) {
      await c.query(
        `INSERT INTO review_items(id,session_id,card_id,card_version,direction,schedule_revision,position,available_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          randomUUID(),
          sessionId,
          r.id,
          r.current_version,
          r.direction,
          r.revision,
          position,
          now,
        ],
      );
      await c.query(
        "INSERT INTO review_introductions(card_id,introduced_at) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [r.id, now],
      );
    }
  });
  return getToday(db, owner, now);
}
export async function endReview(db: Pool, owner: string, sessionId: string) {
  await transaction(db, owner, async (c) => {
    await c.query(
      `UPDATE review_items SET status='skipped' WHERE session_id IN
      (SELECT id FROM review_sessions WHERE id=$1 AND owner_id=$2) AND status='pending'`,
      [sessionId, owner],
    );
    await c.query(
      "UPDATE review_sessions SET active=false WHERE id=$1 AND owner_id=$2",
      [sessionId, owner],
    );
  });
}
export async function prepareAnswer(
  db: Pool,
  owner: string,
  id: string,
  answer: string,
  now = new Date(),
) {
  return transaction(db, owner, async (c) => {
    const i = await validItem(c, owner, id, now);
    if (i.answer !== null && i.answer !== answer)
      throw new ReviewError(
        409,
        "answer_conflict",
        "This answer was already submitted. Retry the same answer or use self-assessment.",
      );
    if (i.grade) return { item: i, grade: i.grade };
    if (i.revealed)
      throw new ReviewError(
        409,
        "revealed",
        "The reference was revealed. Use self-assessment instead.",
      );
    await c.query("UPDATE review_items SET answer=$2 WHERE id=$1", [
      id,
      answer,
    ]);
    const reference = reviewSides(i.content, i.direction).reference;
    const grade: Grade | null = exactAnswer(answer, reference)
      ? {
          verdict: "correct",
          reason: "Matches the saved answer (NFC and whitespace only).",
          correction: null,
          source: "exact",
        }
      : null;
    if (grade)
      await c.query("UPDATE review_items SET grade=$2 WHERE id=$1", [
        id,
        JSON.stringify(grade),
      ]);
    return { item: { ...i, answer }, grade };
  });
}
export async function storeGrade(
  db: Pool,
  owner: string,
  id: string,
  answer: string,
  grade: Grade,
  now = new Date(),
) {
  return transaction(db, owner, async (c) => {
    const i = await validItem(c, owner, id, now);
    if (i.answer !== answer)
      throw new ReviewError(
        409,
        "answer_conflict",
        "The submitted answer changed.",
      );
    // A reveal/finalization racing inference wins; late model output cannot overwrite it.
    if (!i.grade && !i.revealed)
      await c.query("UPDATE review_items SET grade=$2 WHERE id=$1", [
        id,
        JSON.stringify(grade),
      ]);
  });
}
export async function revealAnswer(
  db: Pool,
  owner: string,
  id: string,
  now = new Date(),
) {
  await transaction(db, owner, async (c) => {
    const i = await validItem(c, owner, id, now);
    const grade: Grade = {
      verdict: "incorrect",
      reason: "Answer revealed without verified recall.",
      correction: null,
      source: "reveal",
    };
    await c.query(
      "UPDATE review_items SET revealed=true,grade=COALESCE(grade,$2::jsonb) WHERE id=$1",
      [i.id, JSON.stringify(grade)],
    );
  });
}
export async function finalizeReview(
  db: Pool,
  owner: string,
  id: string,
  decision: "accept" | "good" | "again" | "skip",
  now = new Date(),
): Promise<{ decision: string; dueAt?: string }> {
  return transaction(db, owner, async (c) => {
    const previous = await item(c, owner, id);
    if (previous.result) {
      if (previous.result.decision !== decision)
        throw new ReviewError(
          409,
          "decision_conflict",
          "This review was already finalized with another decision.",
        );
      return previous.result;
    }
    const i = await validItem(c, owner, id, now);
    if (decision === "skip") {
      const result = { decision };
      await c.query(
        "UPDATE review_items SET status='skipped',result=$2 WHERE id=$1",
        [id, JSON.stringify(result)],
      );
      await prune(c, owner, now);
      return result;
    }
    if (!i.grade)
      throw new ReviewError(
        409,
        "unchecked",
        "Check or reveal the answer before rating recall.",
      );
    const rating = decision === "accept" ? automaticRating(i.grade) : decision;
    if (!rating)
      throw new ReviewError(
        409,
        "self_assessment",
        "This judgment needs your self-assessment. Scheduling has not changed.",
      );
    const schedule = (
      await c.query(
        "SELECT state FROM review_schedules WHERE card_id=$1 AND direction=$2",
        [i.card_id, i.direction],
      )
    ).rows[0];
    const before = schedule.state as CardInput;
    const after = scheduleReview(before, rating, now);
    const p = await preferences(c, owner);
    const nextDay = (
      await c.query(
        `SELECT ((($1::timestamptz AT TIME ZONE $2)::date + 1)::timestamp AT TIME ZONE $2) AS start`,
        [now, p.timezone],
      )
    ).rows[0].start as Date;
    // FSRS still learns from mistakes, but their next challenge is tomorrow.
    // Successful recall keeps its FSRS interval, with no same-day learning steps.
    after.card.due =
      rating === "again" || after.card.due < nextDay ? nextDay : after.card.due;
    const result = { decision, dueAt: after.card.due.toISOString() };
    await c.query(
      `INSERT INTO review_events(attempt_id,owner_id,card_id,card_version,direction,answer,grade,rating,source,
      reviewed_at,before_state,after_state,scheduler_version,scheduler_parameters)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        id,
        owner,
        i.card_id,
        i.card_version,
        i.direction,
        i.answer,
        JSON.stringify(i.grade),
        rating,
        decision === "accept" ? "automatic" : "self",
        now,
        JSON.stringify(before),
        JSON.stringify(after.card),
        SCHEDULER_VERSION,
        JSON.stringify(SCHEDULER_PARAMETERS),
      ],
    );
    const updated = await c.query(
      `UPDATE review_schedules SET state=$4,due_at=$5,revision=revision+1
      WHERE card_id=$1 AND direction=$2 AND revision=$3 RETURNING revision`,
      [
        i.card_id,
        i.direction,
        i.schedule_revision,
        JSON.stringify(after.card),
        after.card.due,
      ],
    );
    if (!updated.rowCount)
      throw new ReviewError(
        409,
        "schedule_conflict",
        "Another tab already reviewed this direction.",
      );
    await c.query(
      "UPDATE review_items SET status='finalized',result=$2 WHERE id=$1",
      [id, JSON.stringify(result)],
    );
    await prune(c, owner, now);
    return result;
  });
}
