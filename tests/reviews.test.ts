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
      goal: 12,
      completed: 0,
      attempts: 0,
      dueCards: 1,
      dueDirections: 2,
      newRemaining: 5,
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
  it("freezes and resumes one direction per card with at most five new cards", async () => {
    for (let i = 0; i < 8; i++) await save(i);
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
    expect(items).toHaveLength(5);
    expect(new Set(items.map((i) => i.card_id)).size).toBe(5);
    expect(first.newRemaining).toBe(0);
    expect(first.session?.item?.reference).toBeNull();
    expect(resumed.session?.item?.id).toBe(first.session?.item?.id);
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
      scheduler_version: "ts-fsrs-5.2.0/fsrs-6/webcards-v1",
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
    expect(later.session?.remaining).toBe(1);
    expect(Date.parse(later.session!.item!.availableAt) - now.getTime()).toBe(
      60000,
    );
  });
  it("records relearning repeats and both directions without inflating the distinct-card goal", async () => {
    await save();
    let { item } = await session();
    await revealAnswer(getDb(), owner, item.id, now);
    await finalizeReview(getDb(), owner, item.id, "again", now);
    let today = await getToday(getDb(), owner, now);
    const repeat = today.session!.item!;
    await expect(
      prepareAnswer(getDb(), owner, repeat.id, reference(repeat), now),
    ).rejects.toMatchObject({ code: "not_due" });
    const later = new Date(now.getTime() + 60000);
    await prepareAnswer(getDb(), owner, repeat.id, reference(repeat), later);
    await finalizeReview(getDb(), owner, repeat.id, "accept", later);
    today = await getToday(getDb(), owner, later);
    if (today.session) await endReview(getDb(), owner, today.session.id);
    today = await startReview(getDb(), owner, later);
    item = today.session!.item!;
    await prepareAnswer(getDb(), owner, item.id, reference(item), later);
    await finalizeReview(getDb(), owner, item.id, "accept", later);
    expect(await getToday(getDb(), owner, later)).toMatchObject({
      completed: 1,
      attempts: 3,
    });
    expect(new Set((await events()).map((e) => e.direction)).size).toBe(2);
  });
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
  it("prioritizes existing due backlog over new cards and leaves the other direction untouched", async () => {
    const first = await save();
    const { today, item } = await session();
    await revealAnswer(getDb(), owner, item.id, now);
    await finalizeReview(getDb(), owner, item.id, "again", now);
    await endReview(getDb(), owner, today.session!.id);
    await save(1);
    const started = await startReview(getDb(), owner, now);
    expect(started.session?.remaining).toBe(1);
    expect(started.session?.item?.cardId).toBe(first.cardId);
    expect(started.newRemaining).toBe(0);
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
