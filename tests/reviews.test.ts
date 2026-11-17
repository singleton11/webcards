import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { disposablePostgres, testEnvironment } from "./helpers/postgres";
import { getDb } from "../src/lib/db";
import { createOwner, migrate } from "../src/lib/persistence";
import { saveCard, changeCard } from "../src/lib/cards";
import { saveCardSchema } from "../src/lib/card-contracts";
import {
  endReview,
  finalizeReview,
  getToday,
  prepareAnswer,
  revealAnswer,
  startReview,
  storeGrade,
} from "../src/lib/reviews";
import { handleReviewRequest } from "../src/lib/review-api";
import { GradingService } from "../src/lib/grading";
import { handleAuthRequest } from "../src/lib/auth-handler";

let postgres: Awaited<ReturnType<typeof disposablePostgres>>,
  owner: string,
  cookie: string;
const other = "other-review-owner",
  now = new Date("2030-01-01T12:00:00Z");
const config = {
  baseURL: "http://fixture.invalid/v1",
  apiKey: "fixture-only",
  model: "chatgpt-gpt-6-luna",
};
async function save(i = 0, asOwner = owner) {
  return saveCard(
    getDb(),
    asOwner,
    saveCardSchema.parse({
      requestId: crypto.randomUUID(),
      source: "ru",
      model: config.model,
      promptVersion: "translate-v1",
      content: {
        russian: "берег " + i,
        english: "bank " + i,
        sense: "river edge",
        context: "by the river",
        note: "",
      },
    }),
  );
}
async function session() {
  const today = await startReview(getDb(), owner, now);
  return { today, item: today.session!.item! };
}
function reference(item: { direction: string; prompt: string }) {
  return item.direction === "ru-en"
    ? item.prompt.replace("берег", "bank")
    : item.prompt.replace("bank", "берег");
}
async function events() {
  return (
    await getDb().query(
      "SELECT * FROM review_events ORDER BY reviewed_at,attempt_id",
    )
  ).rows;
}
function request(
  method: string,
  body?: unknown,
  authenticated = true,
  origin = "http://127.0.0.1:3000",
) {
  return new Request("http://127.0.0.1:3000/api/reviews", {
    method,
    headers: {
      origin,
      "content-type": "application/json",
      ...(authenticated ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
beforeAll(async () => {
  postgres = await disposablePostgres();
  testEnvironment(postgres.url);
  await migrate(getDb());
  owner = await createOwner(getDb(), "owner", "isolated-password-1234");
  await getDb().query(
    `INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt",username,"displayUsername") VALUES($1,'other','other@owner.invalid',true,now(),now(),'other','other')`,
    [other],
  );
  await getDb().query("INSERT INTO owner_preferences(owner_id) VALUES($1)", [
    other,
  ]);
  const login = await handleAuthRequest(
    new Request("http://127.0.0.1:3000/api/auth/sign-in/username", {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1:3000",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        username: "owner",
        password: "isolated-password-1234",
      }),
    }),
  );
  cookie = login.headers.get("set-cookie")!.split(";")[0];
}, 30000);
beforeEach(async () => {
  await getDb().query(
    "DELETE FROM cards; DELETE FROM review_sessions; DELETE FROM card_receipts; DELETE FROM grading_usage",
  );
  await getDb().query(
    "UPDATE owner_preferences SET timezone='UTC',daily_goal=12",
  );
});
afterAll(async () => {
  await getDb().end();
  postgres?.stop();
});

describe("daily reviews", () => {
  it("upgrades existing cards without altering content or owner credentials", async () => {
    const saved = await save();
    await migrate(getDb());
    const today = await getToday(getDb(), owner, now);
    expect(today).toMatchObject({
      completed: 0,
      attempts: 0,
      dueCards: 1,
      dueDirections: 2,
      totalCards: 1,
      session: null,
    });
    expect(
      (
        await getDb().query("SELECT current_version FROM cards WHERE id=$1", [
          saved.cardId,
        ])
      ).rows[0].current_version,
    ).toBe(1);
  });
  it("counts all active cards once, including future reviews, without leaking other owners or archived cards", async () => {
    expect((await getToday(getDb(), owner, now)).totalCards).toBe(0);
    await save(0);
    const future = await save(1);
    const archived = await save(2);
    await save(0, other);
    await getToday(getDb(), owner, now);
    await getDb().query(
      "UPDATE review_schedules SET due_at=$2 WHERE card_id=$1",
      [future.cardId, new Date("2031-01-01T00:00:00Z")],
    );
    await changeCard(getDb(), owner, archived.cardId, {
      action: "archive",
      revision: 1,
      requestId: crypto.randomUUID(),
    });
    expect(await getToday(getDb(), owner, now)).toMatchObject({
      totalCards: 2,
      dueCards: 1,
      dueDirections: 2,
    });
    expect((await getToday(getDb(), other, now)).totalCards).toBe(1);
    await changeCard(getDb(), owner, archived.cardId, {
      action: "restore",
      revision: 2,
      requestId: crypto.randomUUID(),
    });
    expect((await getToday(getDb(), owner, now)).totalCards).toBe(3);
    await changeCard(getDb(), owner, future.cardId, {
      action: "delete",
      revision: 1,
      requestId: crypto.randomUUID(),
    });
    expect((await getToday(getDb(), owner, now)).totalCards).toBe(2);
  });
  it("freezes and resumes all eligible cards beyond the old daily, session and scan limits", async () => {
    for (let i = 0; i < 205; i++) await save(i);
    const first = await startReview(getDb(), owner, now);
    const resumed = await startReview(
      getDb(),
      owner,
      new Date(now.getTime() + 1000),
    );
    expect(resumed.session?.id).toBe(first.session?.id);
    const items = (
      await getDb().query(
        "SELECT card_id,direction FROM review_items ORDER BY position",
      )
    ).rows;
    expect(items).toHaveLength(205);
    expect(new Set(items.map((i) => i.card_id)).size).toBe(205);
    expect(first.totalCards).toBe(205);
    expect(first.session?.item?.reference).toBeNull();
    expect(resumed.session?.item?.id).toBe(first.session?.item?.id);
  });
  it("drains every eligible card once, regardless of result, including cards saved after finishing", async () => {
    for (let i = 0; i < 14; i++) await save(i);
    let today = await startReview(getDb(), owner, now);
    const seen = new Set<string>();
    while (today.session?.item) {
      const item = today.session.item;
      expect(seen.has(item.cardId)).toBe(false);
      seen.add(item.cardId);
      if (seen.size % 2) {
        await prepareAnswer(getDb(), owner, item.id, reference(item), now);
        await finalizeReview(getDb(), owner, item.id, "accept", now);
      } else {
        await revealAnswer(getDb(), owner, item.id, now);
        await finalizeReview(getDb(), owner, item.id, "again", now);
      }
      today = await getToday(getDb(), owner, now);
    }
    expect(seen.size).toBe(14);
    expect(await startReview(getDb(), owner, now)).toMatchObject({
      completed: 14,
      attempts: 14,
      dueCards: 0,
      session: null,
    });
    const added = await save(14);
    expect((await startReview(getDb(), owner, now)).session?.item?.cardId).toBe(
      added.cardId,
    );
  });
  it("checks exact answers without grading or changing either schedule; finalizes only one direction", async () => {
    const saved = await save();
    const { item } = await session();
    const before = (
      await getDb().query(
        "SELECT * FROM review_schedules WHERE card_id=$1 ORDER BY direction",
        [saved.cardId],
      )
    ).rows;
    expect(
      (await prepareAnswer(getDb(), owner, item.id, reference(item), now)).grade
        ?.source,
    ).toBe("exact");
    expect(await events()).toHaveLength(0);
    await finalizeReview(getDb(), owner, item.id, "accept", now);
    const after = (
      await getDb().query(
        "SELECT * FROM review_schedules WHERE card_id=$1 ORDER BY direction",
        [saved.cardId],
      )
    ).rows;
    expect(after.find((s) => s.direction !== item.direction)).toEqual(
      before.find((s) => s.direction !== item.direction),
    );
    expect(after.find((s) => s.direction === item.direction).revision).toBe(2);
    expect((await events())[0]).toMatchObject({
      card_version: 1,
      direction: item.direction,
      rating: "good",
      source: "automatic",
      scheduler_version: "ts-fsrs-5.2.0/fsrs-6/webcards-v2",
    });
  });
  it("replays finalization durably across concurrent tabs and rejects a different decision", async () => {
    await save();
    const { item } = await session();
    await revealAnswer(getDb(), owner, item.id, now);
    const result = await Promise.all(
      Array.from({ length: 6 }, () =>
        finalizeReview(getDb(), owner, item.id, "again", now),
      ),
    );
    expect(result.every((r) => r.dueAt === result[0].dueAt)).toBe(true);
    expect(await events()).toHaveLength(1);
    await expect(
      finalizeReview(getDb(), owner, item.id, "good", now),
    ).rejects.toMatchObject({ code: "decision_conflict" });
    const later = await getToday(getDb(), owner, now);
    expect(later).toMatchObject({ completed: 1, attempts: 1 });
    expect(later.session).toBeNull();
    expect(later.dueCards).toBe(0);
    expect(result[0].dueAt).toBe("2030-01-02T00:00:00.000Z");
  });
  it("retries a wrong direction tomorrow, never either direction again today", async () => {
    await save();
    const { item } = await session();
    await revealAnswer(getDb(), owner, item.id, now);
    await finalizeReview(getDb(), owner, item.id, "again", now);
    expect(
      await startReview(getDb(), owner, new Date("2030-01-01T23:59:59Z")),
    ).toMatchObject({
      completed: 1,
      attempts: 1,
      dueCards: 0,
      dueDirections: 0,
      totalCards: 1,
      session: null,
    });
    const tomorrow = new Date("2030-01-02T00:00:00Z");
    const today = await startReview(getDb(), owner, tomorrow);
    const repeat = today.session!.item!;
    expect(repeat.direction).toBe(item.direction);
    expect(repeat.cardId).toBe(item.cardId);
    await prepareAnswer(getDb(), owner, repeat.id, reference(repeat), tomorrow);
    const result = await finalizeReview(
      getDb(),
      owner,
      repeat.id,
      "accept",
      tomorrow,
    );
    expect(Date.parse(result.dueAt!)).toBeGreaterThan(
      tomorrow.getTime() + 86400000,
    );
    expect(await startReview(getDb(), owner, tomorrow)).toMatchObject({
      completed: 1,
      attempts: 1,
      dueCards: 0,
      session: null,
    });
    // The opposite direction keeps its independent schedule for a later day.
    const next = await startReview(
      getDb(),
      owner,
      new Date("2030-01-03T00:00:00Z"),
    );
    expect(next.session?.item?.direction).not.toBe(item.direction);
    expect(await events()).toHaveLength(2);
  });
  it("retires legacy same-day queued repeats when resuming an old session", async () => {
    await save();
    const { item } = await session();
    await revealAnswer(getDb(), owner, item.id, now);
    await finalizeReview(getDb(), owner, item.id, "again", now);
    const oldSession = crypto.randomUUID();
    await getDb().query(
      "INSERT INTO review_sessions(id,owner_id,created_at) VALUES($1,$2,$3)",
      [oldSession, owner, now],
    );
    await getDb().query(
      `INSERT INTO review_items(id,session_id,card_id,card_version,direction,schedule_revision,position,available_at)
      SELECT $1,$2,card_id,1,direction,revision,0,$3 FROM review_schedules WHERE card_id=$4 AND direction=$5`,
      [crypto.randomUUID(), oldSession, now, item.cardId, item.direction],
    );
    expect(await getToday(getDb(), owner, now)).toMatchObject({
      dueCards: 0,
      session: null,
    });
    expect(await startReview(getDb(), owner, now)).toMatchObject({
      dueCards: 0,
      session: null,
    });
  });
  it.each([
    ["2030-03-31T00:30:00Z", "2030-03-31T22:00:00Z"],
    ["2030-10-27T00:30:00Z", "2030-10-27T23:00:00Z"],
  ])(
    "makes a wrong answer due at the next local midnight across DST (%s)",
    async (at, expected) => {
      await getDb().query(
        "UPDATE owner_preferences SET timezone='Europe/Amsterdam' WHERE owner_id=$1",
        [owner],
      );
      await save();
      const instant = new Date(at);
      const item = (await startReview(getDb(), owner, instant)).session!.item!;
      await revealAnswer(getDb(), owner, item.id, instant);
      const result = await finalizeReview(
        getDb(),
        owner,
        item.id,
        "again",
        instant,
      );
      expect(result.dueAt).toBe(new Date(expected).toISOString());
      expect(
        (await startReview(getDb(), owner, new Date(Date.parse(expected) - 1)))
          .session,
      ).toBeNull();
      expect(
        (await startReview(getDb(), owner, new Date(expected))).session?.item
          ?.direction,
      ).toBe(item.direction);
    },
  );
  it("keeps abstentions and typos pending, records self-assessment without rewriting the original verdict", async () => {
    await save();
    const { item } = await session();
    await prepareAnswer(getDb(), owner, item.id, "a possible synonym", now);
    await storeGrade(
      getDb(),
      owner,
      item.id,
      "a possible synonym",
      {
        verdict: "needs_review",
        reason: "Ambiguous prompt.",
        correction: null,
        source: "model",
        model: config.model,
        promptVersion: "grade-v1",
      },
      now,
    );
    await expect(
      finalizeReview(getDb(), owner, item.id, "accept", now),
    ).rejects.toMatchObject({ code: "self_assessment" });
    expect(await events()).toHaveLength(0);
    await finalizeReview(getDb(), owner, item.id, "good", now);
    expect((await events())[0]).toMatchObject({
      rating: "good",
      source: "self",
      grade: { verdict: "needs_review" },
    });
  });
  it("preserves submitted text after model failure; skip/end do not update schedules or count toward the goal", async () => {
    await save();
    const { today, item } = await session();
    await prepareAnswer(getDb(), owner, item.id, "shore", now);
    expect((await getToday(getDb(), owner, now)).session?.item).toMatchObject({
      answer: "shore",
      grade: null,
      reference: null,
    });
    await expect(
      prepareAnswer(getDb(), owner, item.id, "another answer", now),
    ).rejects.toMatchObject({ code: "answer_conflict" });
    await finalizeReview(getDb(), owner, item.id, "skip", now);
    await endReview(getDb(), owner, today.session!.id);
    expect(await events()).toHaveLength(0);
    expect(await getToday(getDb(), owner, now)).toMatchObject({
      completed: 0,
      attempts: 0,
      dueDirections: 2,
      session: null,
    });
  });
  it("rejects edits during grading and preserves historical card versions after later edits", async () => {
    const saved = await save();
    const { item } = await session();
    await prepareAnswer(getDb(), owner, item.id, reference(item), now);
    await changeCard(getDb(), owner, saved.cardId, {
      action: "edit",
      requestId: crypto.randomUUID(),
      revision: 1,
      content: { ...saved.card!.content, english: "shore" },
    });
    await expect(
      finalizeReview(getDb(), owner, item.id, "accept", now),
    ).rejects.toMatchObject({ code: "stale_review" });
    expect(await events()).toHaveLength(0);
    const next = await startReview(getDb(), owner, now);
    expect(next.session?.item?.id).not.toBe(item.id);
    const i = next.session!.item!;
    await revealAnswer(getDb(), owner, i.id, now);
    await finalizeReview(getDb(), owner, i.id, "again", now);
    await changeCard(getDb(), owner, saved.cardId, {
      action: "edit",
      requestId: crypto.randomUUID(),
      revision: 2,
      content: { ...saved.card!.content, english: "river bank" },
    });
    expect((await events())[0].card_version).toBe(2);
    expect(
      (
        await getDb().query(
          "SELECT state FROM review_schedules WHERE card_id=$1 AND direction=$2",
          [saved.cardId, i.direction],
        )
      ).rows[0].state.reps,
    ).toBe(1);
  });
  it("prevents stale directional schedule writes and rolls back the event transaction", async () => {
    await save();
    const { item } = await session();
    await revealAnswer(getDb(), owner, item.id, now);
    await getDb().query(
      "UPDATE review_schedules SET revision=revision+1 WHERE direction=$1",
      [item.direction],
    );
    await expect(
      finalizeReview(getDb(), owner, item.id, "again", now),
    ).rejects.toMatchObject({ code: "stale_review" });
    expect(await events()).toHaveLength(0);
  });
  it("archives out of the queue, preserves schedules on restore, and deletes all private review data", async () => {
    const saved = await save();
    const { item } = await session();
    await revealAnswer(getDb(), owner, item.id, now);
    await finalizeReview(getDb(), owner, item.id, "again", now);
    await changeCard(getDb(), owner, saved.cardId, {
      action: "archive",
      revision: 1,
      requestId: crypto.randomUUID(),
    });
    expect(await getToday(getDb(), owner, now)).toMatchObject({
      dueCards: 0,
      session: null,
    });
    await changeCard(getDb(), owner, saved.cardId, {
      action: "restore",
      revision: 2,
      requestId: crypto.randomUUID(),
    });
    expect(
      (
        await getDb().query(
          "SELECT sum((state->>'reps')::int)::int AS reps FROM review_schedules",
        )
      ).rows[0].reps,
    ).toBe(1);
    await changeCard(getDb(), owner, saved.cardId, {
      action: "delete",
      revision: 3,
      requestId: crypto.randomUUID(),
    });
    for (const table of [
      "review_events",
      "review_items",
      "review_schedules",
      "review_introductions",
    ])
      expect(
        (await getDb().query(`SELECT count(*)::int AS total FROM ${table}`))
          .rows[0].total,
      ).toBe(0);
  });
  it("offers an explicit idempotent learning reset without erasing review history", async () => {
    const saved = await save();
    const { item } = await session();
    await revealAnswer(getDb(), owner, item.id, now);
    await finalizeReview(getDb(), owner, item.id, "again", now);
    const reset = {
      action: "reset" as const,
      revision: 1,
      requestId: crypto.randomUUID(),
    };
    const first = await changeCard(getDb(), owner, saved.cardId, reset);
    expect(await changeCard(getDb(), owner, saved.cardId, reset)).toEqual(
      first,
    );
    expect(first.outcome).toBe("reset");
    expect(await events()).toHaveLength(1);
    expect(
      (
        await getDb().query(
          "SELECT state->>'reps' AS reps FROM review_schedules",
        )
      ).rows.every((r) => r.reps === "0"),
    ).toBe(true);
    expect((await getToday(getDb(), owner, now)).session).toBeNull();
  });
  it("prioritizes missed cards tomorrow without blocking new cards behind the backlog", async () => {
    const first = await save();
    const { item } = await session();
    await revealAnswer(getDb(), owner, item.id, now);
    await finalizeReview(getDb(), owner, item.id, "again", now);
    await save(1);
    const started = await startReview(
      getDb(),
      owner,
      new Date("2030-01-02T00:00:00Z"),
    );
    expect(started.session?.remaining).toBe(2);
    expect(started.session?.item?.cardId).toBe(first.cardId);
  });
  it("counts goals in the owner's chosen timezone across midnight and travel", async () => {
    await save();
    const at = new Date("2030-01-01T23:30:00Z");
    const t = await startReview(getDb(), owner, at);
    const i = t.session!.item!;
    await revealAnswer(getDb(), owner, i.id, at);
    await finalizeReview(getDb(), owner, i.id, "again", at);
    await getDb().query(
      "UPDATE owner_preferences SET timezone='Europe/Amsterdam' WHERE owner_id=$1",
      [owner],
    );
    expect(
      await getToday(getDb(), owner, new Date("2030-01-02T00:30:00Z")),
    ).toMatchObject({ completed: 1, day: "2030-01-02" });
    await getDb().query(
      "UPDATE owner_preferences SET timezone='America/New_York' WHERE owner_id=$1",
      [owner],
    );
    expect(
      await getToday(getDb(), owner, new Date("2030-01-02T00:30:00Z")),
    ).toMatchObject({ completed: 1, day: "2030-01-01" });
    expect(
      await getToday(getDb(), owner, new Date("2030-01-02T05:00:00Z")),
    ).toMatchObject({ completed: 0, day: "2030-01-02" });
  });
  it("enforces authentication, origin, strict contracts, private no-store responses and owner isolation", async () => {
    await save();
    const { item } = await session();
    expect(
      (await handleReviewRequest(request("GET", undefined, false))).status,
    ).toBe(401);
    expect(
      (
        await handleReviewRequest(
          request(
            "POST",
            { action: "start" },
            true,
            "https://untrusted.invalid",
          ),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handleReviewRequest(
          request("POST", {
            action: "check",
            itemId: item.id,
            answer: "bank",
            reference: "forged",
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await handleReviewRequest(request("GET"))).headers.get("cache-control"),
    ).toBe("private, no-store");
    await expect(
      prepareAnswer(getDb(), other, item.id, "bank", now),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      finalizeReview(getDb(), other, item.id, "again", now),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await getToday(getDb(), other, now)).toMatchObject({
      dueCards: 0,
      totalCards: 0,
      session: null,
    });
  });
  it("uses a conservative daily grading budget and exact matches consume none", async () => {
    await save();
    const current = await startReview(getDb(), owner);
    const i = current.session!.item!;
    const service = new GradingService();
    await service.check(getDb(), owner, i.id, reference(i), config, 2);
    expect((await getDb().query("SELECT * FROM grading_usage")).rowCount).toBe(
      0,
    );
    await endReview(getDb(), owner, current.session!.id);
    const second = await startReview(getDb(), owner);
    const next = second.session!.item!;
    const failure = vi.fn().mockRejectedValue(new Error("fixture offline"));
    vi.stubGlobal("fetch", failure);
    try {
      await expect(
        service.check(getDb(), owner, next.id, "a synonym", config, 2),
      ).rejects.toMatchObject({ code: "invalid_grade" });
      expect(failure).toHaveBeenCalledTimes(2);
      await expect(
        service.check(getDb(), owner, next.id, "a synonym", config, 2),
      ).rejects.toMatchObject({ code: "daily_limit" });
      expect(await events()).toHaveLength(0);
      expect((await getToday(getDb(), owner)).session?.item?.answer).toBe(
        "a synonym",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
