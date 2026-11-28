import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { disposablePostgres, testEnvironment } from "./helpers/postgres";
import { getDb } from "../src/lib/db";
import { createOwner, migrate } from "../src/lib/persistence";
import {
  cardContentSchema,
  cardQuerySchema,
  saveCardSchema,
  type CardContent,
} from "../src/lib/card-contracts";
import {
  cardFingerprint,
  changeCard,
  getCard,
  listCards,
  saveCard,
} from "../src/lib/cards";
import { handleCardRequest } from "../src/lib/card-api";
import { handleAuthRequest } from "../src/lib/auth-handler";

let postgres: Awaited<ReturnType<typeof disposablePostgres>>,
  owner: string,
  cookie: string;
const other = "another-owner-for-isolation";
const content: CardContent = {
  russian: "берег",
  english: "bank",
  sense: "river edge",
  context: "by the river",
  note: "Not a financial institution.",
};
function input(
  overrides: Partial<CardContent> = {},
  source: "ru" | "en" = "ru",
) {
  return saveCardSchema.parse({
    requestId: crypto.randomUUID(),
    content: { ...content, ...overrides },
    source,
    model: "chatgpt-gpt-6-luna",
    promptVersion: "translate-v1",
  });
}
function command(action: "archive" | "restore" | "delete", revision: number) {
  return { requestId: crypto.randomUUID(), action, revision };
}
function request(
  method: string,
  body?: unknown,
  options: {
    origin?: string;
    authenticated?: boolean;
    query?: string;
    contentType?: string;
  } = {},
) {
  return new Request(
    "http://127.0.0.1:3000/api/cards" + (options.query ?? ""),
    {
      method,
      headers: {
        origin: options.origin ?? "http://127.0.0.1:3000",
        "content-type": options.contentType ?? "application/json",
        ...(options.authenticated === false ? {} : { cookie }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
}
beforeAll(async () => {
  postgres = await disposablePostgres();
  testEnvironment(postgres.url);
  await migrate(getDb());
  owner = await createOwner(getDb(), "owner", "isolated-password-1234");
  await getDb().query(
    `INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt",username,"displayUsername")
    VALUES ($1,'another','another@owner.invalid',true,now(),now(),'another','another')`,
    [other],
  );
  const response = await handleAuthRequest(
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
  cookie = response.headers.get("set-cookie")!.split(";")[0];
}, 30000);
beforeEach(async () => {
  await getDb().query("DELETE FROM cards");
  await getDb().query("DELETE FROM card_receipts");
});
afterAll(async () => {
  await getDb().end();
  postgres?.stop();
});

describe("vocabulary persistence", () => {
  it("upgrades the foundation migration idempotently", async () => {
    await migrate(getDb());
    expect(
      (
        await getDb().query(
          "SELECT version FROM schema_migrations ORDER BY version",
        )
      ).rows.map((r) => r.version),
    ).toEqual([
      "0001_owner_foundations",
      "0002_vocabulary",
      "0003_daily_review",
      "0004_evening_reminders",
    ]);
  });
  it("upgrades an existing owner foundation without changing credentials or preferences", async () => {
    const credentials = (
      await getDb().query('SELECT password FROM account WHERE "userId"=$1', [
        owner,
      ])
    ).rows;
    await getDb().query(
      "DROP TABLE review_events, review_items, review_sessions, review_schedules, review_introductions, grading_usage, card_receipts, card_versions, cards CASCADE",
    );
    await getDb().query(
      "DELETE FROM schema_migrations WHERE version IN ('0002_vocabulary','0003_daily_review')",
    );
    await getDb().query(
      "UPDATE owner_preferences SET daily_goal=19 WHERE owner_id=$1",
      [owner],
    );
    await migrate(getDb());
    expect(
      (
        await getDb().query(
          "SELECT daily_goal FROM owner_preferences WHERE owner_id=$1",
          [owner],
        )
      ).rows[0].daily_goal,
    ).toBe(19);
    expect(
      (
        await getDb().query('SELECT password FROM account WHERE "userId"=$1', [
          owner,
        ])
      ).rows,
    ).toEqual(credentials);
    expect((await saveCard(getDb(), owner, input())).outcome).toBe("created");
  });
  it("normalizes NFC and whitespace without discarding punctuation, case, or accents", () => {
    const parsed = cardContentSchema.parse({
      ...content,
      russian: "  бере\u0301г\n ",
      english: "  river\t bank ",
    });
    expect(parsed.russian).toBe("бере́г");
    expect(parsed.english).toBe("river bank");
    expect(cardFingerprint({ ...content, english: "Bank" })).not.toBe(
      cardFingerprint(content),
    );
    expect(cardFingerprint({ ...content, russian: "берёг" })).not.toBe(
      cardFingerprint(content),
    );
    expect(
      cardContentSchema.safeParse({ ...content, english: "\0bad" }).success,
    ).toBe(false);
    expect(
      cardContentSchema.safeParse({ ...content, english: " " }).success,
    ).toBe(false);
    expect(
      cardContentSchema.safeParse({ ...content, english: "a".repeat(1001) })
        .success,
    ).toBe(false);
  });
  it("persists one meaning, original direction, metadata and content version", async () => {
    const result = await saveCard(getDb(), owner, input());
    expect(result.outcome).toBe("created");
    expect(await getCard(getDb(), owner, result.cardId)).toMatchObject({
      content,
      source: "ru",
      version: 1,
      revision: 1,
      model: "chatgpt-gpt-6-luna",
    });
    expect(
      (await listCards(getDb(), owner, cardQuerySchema.parse({}))).total,
    ).toBe(1);
  });
  it("deduplicates concurrent saves, reverse directions and normalized text", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        saveCard(
          getDb(),
          owner,
          input({ russian: "  берег  " }, i % 2 ? "en" : "ru"),
        ),
      ),
    );
    expect(new Set(results.map((r) => r.cardId)).size).toBe(1);
    expect(results.filter((r) => r.outcome === "created")).toHaveLength(1);
    expect(
      (await getDb().query("SELECT count(*) FROM cards")).rows[0].count,
    ).toBe("1");
  });
  it("retains distinct senses and contexts but not a second copy just for a note", async () => {
    const first = await saveCard(getDb(), owner, input());
    expect(
      (await saveCard(getDb(), owner, input({ note: "different note" })))
        .cardId,
    ).toBe(first.cardId);
    expect(
      (await saveCard(getDb(), owner, input({ context: "a steep river edge" })))
        .cardId,
    ).not.toBe(first.cardId);
    expect(
      (await saveCard(getDb(), owner, input({ sense: "different sense" })))
        .cardId,
    ).not.toBe(first.cardId);
  });
  it("reviews matching pairs within the account before saving a variant", async () => {
    const first = await saveCard(getDb(), owner, input());
    const candidate = {
      ...input({ sense: "riverbank", english: "  bank  " }, "en"),
      similarPolicy: "review" as const,
    };
    expect(await saveCard(getDb(), owner, candidate)).toMatchObject({
      outcome: "similar",
      cardId: first.cardId,
    });
    expect(await saveCard(getDb(), other, candidate)).toMatchObject({
      outcome: "created",
    });
    expect(
      (await listCards(getDb(), owner, cardQuerySchema.parse({}))).total,
    ).toBe(1);

    const confirmed = {
      ...candidate,
      requestId: crypto.randomUUID(),
      similarPolicy: "keep" as const,
    };
    const second = await saveCard(getDb(), owner, confirmed);
    expect(second.outcome).toBe("created");
    expect(await saveCard(getDb(), owner, confirmed)).toEqual(second);
    expect(await saveCard(getDb(), owner, candidate)).toMatchObject({
      outcome: "duplicate",
      cardId: second.cardId,
    });
  });
  it("replays durable receipts and rejects request ID reuse for a different payload", async () => {
    const save = input();
    const first = await saveCard(getDb(), owner, save);
    expect(await saveCard(getDb(), owner, save)).toEqual(first);
    await expect(
      saveCard(getDb(), owner, {
        ...save,
        content: { ...content, english: "shore" },
      }),
    ).rejects.toMatchObject({ code: "request_conflict" });
  });
  it("fails old receipt replay safely after secret rotation", async () => {
    const save = input();
    const first = await saveCard(getDb(), owner, save);
    const secret = process.env.BETTER_AUTH_SECRET;
    try {
      process.env.BETTER_AUTH_SECRET =
        "rotated-test-secret-not-for-deployment-1234";
      await expect(saveCard(getDb(), owner, save)).rejects.toMatchObject({
        code: "request_conflict",
      });
    } finally {
      process.env.BETTER_AUTH_SECRET = secret;
    }
    expect(await saveCard(getDb(), owner, save)).toEqual(first);
    expect(
      (await listCards(getDb(), owner, cardQuerySchema.parse({}))).total,
    ).toBe(1);
  });
  it("undoes only the newly created, unchanged card and never resurrects it on a late save replay", async () => {
    const save = input();
    const first = await saveCard(getDb(), owner, save);
    const undo = {
      requestId: crypto.randomUUID(),
      action: "undo" as const,
      revision: 1,
      saveRequestId: save.requestId,
    };
    expect((await changeCard(getDb(), owner, first.cardId, undo)).outcome).toBe(
      "undone",
    );
    expect(
      (await changeCard(getDb(), owner, first.cardId, undo)).card,
    ).toBeNull();
    expect((await saveCard(getDb(), owner, save)).card).toBeNull();
    expect(
      (await getDb().query("SELECT count(*) FROM card_versions")).rows[0].count,
    ).toBe("0");
    const receipts = JSON.stringify(
      (await getDb().query("SELECT * FROM card_receipts")).rows,
    );
    expect(receipts).not.toContain(content.russian);
    expect((await saveCard(getDb(), owner, input())).outcome).toBe("created");
  });
  it("does not let a duplicate save or later edit undo an existing card", async () => {
    const first = await saveCard(getDb(), owner, input());
    const retry = input();
    await saveCard(getDb(), owner, retry);
    await expect(
      changeCard(getDb(), owner, first.cardId, {
        requestId: crypto.randomUUID(),
        action: "undo",
        revision: 1,
        saveRequestId: retry.requestId,
      }),
    ).rejects.toMatchObject({ code: "cannot_undo" });
    await changeCard(getDb(), owner, first.cardId, {
      requestId: crypto.randomUUID(),
      action: "edit",
      revision: 1,
      content: { ...content, english: "shore" },
    });
    await expect(
      changeCard(getDb(), owner, first.cardId, {
        requestId: crypto.randomUUID(),
        action: "undo",
        revision: 2,
        saveRequestId: retry.requestId,
      }),
    ).rejects.toMatchObject({ code: "cannot_undo" });
  });
  it("versions edits, preserves old content, and applies a retried edit once", async () => {
    const first = await saveCard(getDb(), owner, input());
    const edit = {
      requestId: crypto.randomUUID(),
      action: "edit" as const,
      revision: 1,
      content: { ...content, english: "shore" },
    };
    const updated = await changeCard(getDb(), owner, first.cardId, edit);
    expect(updated.card).toMatchObject({
      version: 2,
      revision: 2,
      content: { english: "shore" },
    });
    expect(await changeCard(getDb(), owner, first.cardId, edit)).toEqual(
      updated,
    );
    const versions = await getDb().query(
      "SELECT version,english,origin FROM card_versions WHERE card_id=$1 ORDER BY version",
      [first.cardId],
    );
    expect(versions.rows).toEqual([
      { version: 1, english: "bank", origin: "translation" },
      { version: 2, english: "shore", origin: "owner_edit" },
    ]);
  });
  it("rejects stale-tab changes and rolls back an edit that collides with another active meaning", async () => {
    const first = await saveCard(getDb(), owner, input());
    const second = await saveCard(getDb(), owner, input({ english: "shore" }));
    await expect(
      changeCard(getDb(), owner, first.cardId, {
        requestId: crypto.randomUUID(),
        action: "edit",
        revision: 1,
        content: second.card!.content,
      }),
    ).rejects.toMatchObject({ code: "duplicate_card" });
    expect((await getCard(getDb(), owner, first.cardId))?.version).toBe(1);
    const commands = await Promise.allSettled([
      changeCard(getDb(), owner, first.cardId, command("archive", 1)),
      changeCard(getDb(), owner, first.cardId, command("delete", 1)),
    ]);
    expect(commands.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(commands.filter((r) => r.status === "rejected")).toHaveLength(1);
  });
  it("archives, restores, and prevents restoring a duplicate active meaning", async () => {
    const first = await saveCard(getDb(), owner, input());
    await changeCard(getDb(), owner, first.cardId, command("archive", 1));
    expect(
      (await listCards(getDb(), owner, cardQuerySchema.parse({}))).total,
    ).toBe(0);
    expect(
      (
        await listCards(
          getDb(),
          owner,
          cardQuerySchema.parse({ status: "archived" }),
        )
      ).total,
    ).toBe(1);
    await changeCard(getDb(), owner, first.cardId, command("restore", 2));
    await changeCard(getDb(), owner, first.cardId, command("archive", 3));
    await saveCard(getDb(), owner, input());
    await expect(
      changeCard(getDb(), owner, first.cardId, command("restore", 4)),
    ).rejects.toMatchObject({ code: "duplicate_card" });
    expect((await getCard(getDb(), owner, first.cardId))?.status).toBe(
      "archived",
    );
  });
  it("hard-deletes every content version and replays deletion without touching a later save", async () => {
    const first = await saveCard(getDb(), owner, input());
    const deletion = command("delete", 1);
    expect(
      (await changeCard(getDb(), owner, first.cardId, deletion)).outcome,
    ).toBe("deleted");
    const later = await saveCard(getDb(), owner, input());
    expect(
      (await changeCard(getDb(), owner, first.cardId, deletion)).card,
    ).toBeNull();
    expect(await getCard(getDb(), owner, later.cardId)).not.toBeNull();
  });
  it("isolates ownership on read, list, deduplication, update and undo", async () => {
    const first = await saveCard(getDb(), owner, input());
    expect(await getCard(getDb(), other, first.cardId)).toBeNull();
    expect(
      (await listCards(getDb(), other, cardQuerySchema.parse({}))).total,
    ).toBe(0);
    await expect(
      changeCard(getDb(), other, first.cardId, command("delete", 1)),
    ).rejects.toMatchObject({ code: "not_found" });
    expect((await saveCard(getDb(), other, input())).cardId).not.toBe(
      first.cardId,
    );
  });
  it("searches both languages case-insensitively and treats SQL wildcard characters literally", async () => {
    await saveCard(
      getDb(),
      owner,
      input({ russian: "БЕРЕГ", context: "100% of a river_bank" }),
    );
    for (const q of ["берег", "BANK", "100%", "river_bank", "financial"]) {
      expect(
        (await listCards(getDb(), owner, cardQuerySchema.parse({ q }))).total,
      ).toBe(1);
    }
    expect(
      (
        await listCards(
          getDb(),
          owner,
          cardQuerySchema.parse({ q: "missing%" }),
        )
      ).total,
    ).toBe(0);
  });
  it("paginates without dropping or repeating cards", async () => {
    for (let i = 0; i < 52; i++)
      await saveCard(getDb(), owner, input({ context: "context " + i }));
    const first = await listCards(getDb(), owner, cardQuerySchema.parse({}));
    const second = await listCards(
      getDb(),
      owner,
      cardQuerySchema.parse({ page: 2 }),
    );
    expect(first.total).toBe(52);
    expect(first.cards).toHaveLength(50);
    expect(second.cards).toHaveLength(2);
    expect(
      new Set([...first.cards, ...second.cards].map((c) => c.id)).size,
    ).toBe(52);
  });
});
describe("protected card API", () => {
  it("rejects unauthenticated reads/writes and untrusted origins", async () => {
    expect(
      (
        await handleCardRequest(
          request("GET", undefined, { authenticated: false }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await handleCardRequest(
          request("POST", input(), { authenticated: false }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await handleCardRequest(
          request("POST", input(), { origin: "https://evil.test" }),
        )
      ).status,
    ).toBe(403);
  });
  it("validates JSON, body size, fields, IDs and query parameters", async () => {
    expect(
      (
        await handleCardRequest(
          request("POST", input(), { contentType: "text/plain" }),
        )
      ).status,
    ).toBe(415);
    expect(
      (
        await handleCardRequest(
          request("POST", { ...input(), unexpected: true }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await handleCardRequest(request("POST", { text: "a".repeat(20000) })))
        .status,
    ).toBe(413);
    expect(
      (
        await handleCardRequest(
          request("GET", undefined, { query: "?page=-1" }),
        )
      ).status,
    ).toBe(400);
    expect((await handleCardRequest(request("GET"), "not-a-uuid")).status).toBe(
      404,
    );
    const malformed = request("POST", input());
    expect(
      (await handleCardRequest(new Request(malformed, { body: "{" }))).status,
    ).toBe(400);
  });
  it("returns private no-store responses, owner data and safe conflict errors", async () => {
    const save = input();
    const response = await handleCardRequest(request("POST", save));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const result = await response.json();
    expect(
      (await handleCardRequest(request("GET"), result.cardId)).status,
    ).toBe(200);
    expect(
      (
        await handleCardRequest(
          request("POST", command("archive", 10)),
          result.cardId,
        )
      ).status,
    ).toBe(409);
    const foreign = await saveCard(getDb(), other, input());
    expect(
      (await handleCardRequest(request("GET"), foreign.cardId)).status,
    ).toBe(404);
    expect(
      (
        await handleCardRequest(
          request("POST", command("delete", 1)),
          foreign.cardId,
        )
      ).status,
    ).toBe(404);
  });
});
