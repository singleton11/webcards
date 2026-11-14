import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { disposablePostgres, testEnvironment } from "./helpers/postgres";
import { getDb } from "../src/lib/db";
import {
  createAccount,
  createOwner,
  migrate,
  reserveTranslation,
} from "../src/lib/persistence";
import { ownerSession } from "../src/lib/auth";
import { handleAuthRequest } from "../src/lib/auth-handler";
import { handleCardRequest } from "../src/lib/card-api";
import { handleReviewRequest } from "../src/lib/review-api";

const origin = "http://127.0.0.1:3000";
const password = "isolated-password-1234";
let postgres: Awaited<ReturnType<typeof disposablePostgres>>;
let owner: string, second: string, ownerCookie: string, secondCookie: string;
function request(path: string, cookie: string, body?: unknown) {
  return new Request(origin + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { origin, cookie, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function signIn(username: string) {
  const response = await handleAuthRequest(
    request("/api/auth/sign-in/username", "", { username, password }),
  );
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")!.split(";")[0];
}
function input() {
  return {
    requestId: crypto.randomUUID(),
    source: "ru",
    model: "chatgpt-gpt-6-luna",
    promptVersion: "translate-v1",
    content: {
      russian: "\u0440\u0435\u043a\u0430",
      english: "river",
      sense: "watercourse",
      context: "",
      note: "",
    },
  };
}
async function save(cookie: string, body = input()) {
  const response = await handleCardRequest(request("/api/cards", cookie, body));
  expect(response.status).toBe(200);
  return response.json();
}
async function today(cookie: string, command?: unknown) {
  const response = await handleReviewRequest(
    request("/api/reviews", cookie, command),
  );
  expect(response.status).toBe(200);
  return response.json();
}
beforeAll(async () => {
  postgres = await disposablePostgres();
  testEnvironment(postgres.url);
  await migrate(getDb());
  owner = await createOwner(getDb(), "owner", password);
  second = await createAccount(getDb(), "second", password);
  ownerCookie = await signIn("owner");
  secondCookie = await signIn("second");
}, 30000);
beforeEach(async () => {
  await getDb().query("DELETE FROM cards");
  await getDb().query("DELETE FROM review_sessions");
  await getDb().query("DELETE FROM card_receipts");
});
afterAll(async () => {
  await getDb().end();
  postgres?.stop();
});

describe("locally provisioned private accounts", () => {
  it("allows both accounts to access their own workspace with hashed credentials and default preferences", async () => {
    for (const [id, cookie] of [
      [owner, ownerCookie],
      [second, secondCookie],
    ]) {
      expect((await ownerSession(new Headers({ cookie })))?.user.id).toBe(id);
      const account = await getDb().query(
        'SELECT password FROM account WHERE "userId"=$1',
        [id],
      );
      expect(account.rows[0].password).not.toBe(password);
      const prefs = await getDb().query(
        "SELECT timezone,daily_goal FROM owner_preferences WHERE owner_id=$1",
        [id],
      );
      expect(prefs.rows).toEqual([{ timezone: "UTC", daily_goal: 12 }]);
      expect(await today(cookie)).toMatchObject({
        completed: 0,
        session: null,
      });
    }
  });
  it("rejects duplicate and concurrent provisioning without resetting an existing password or preferences", async () => {
    const before = (
      await getDb().query('SELECT password FROM account WHERE "userId"=$1', [
        second,
      ])
    ).rows;
    await expect(
      createAccount(getDb(), "second", "different-password-1234"),
    ).rejects.toThrow("already exists");
    const attempts = await Promise.allSettled([
      createAccount(getDb(), "concurrent", password),
      createAccount(getDb(), "concurrent", password),
    ]);
    expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((a) => a.status === "rejected")).toHaveLength(1);
    expect(
      (
        await getDb().query('SELECT password FROM account WHERE "userId"=$1', [
          second,
        ])
      ).rows,
    ).toEqual(before);
    expect(
      (
        await getDb().query(
          'SELECT count(*)::int AS count FROM "user" u JOIN account a ON a."userId"=u.id JOIN owner_preferences p ON p.owner_id=u.id WHERE u.username=$1',
          ["concurrent"],
        )
      ).rows[0].count,
    ).toBe(1);
  });
  it("validates username and password without writing a partial account", async () => {
    for (const name of ["ab", "NotLowercase", "has space", "x".repeat(31)]) {
      await expect(createAccount(getDb(), name, password)).rejects.toThrow(
        "username",
      );
    }
    for (const invalid of ["short", "x".repeat(129)]) {
      await expect(createAccount(getDb(), "invalid", invalid)).rejects.toThrow(
        "password",
      );
    }
    expect(
      (
        await getDb().query('SELECT id FROM "user" WHERE username=$1', [
          "invalid",
        ])
      ).rowCount,
    ).toBe(0);
    await expect(createOwner(getDb(), "another", password)).rejects.toThrow(
      "already exists",
    );
  });
  it("keeps public registration disabled after adding accounts", async () => {
    const before = (await getDb().query('SELECT count(*) FROM "user"')).rows;
    const response = await handleAuthRequest(
      request("/api/auth/sign-up/email", "", {
        username: "stranger",
        email: "stranger@example.test",
        name: "stranger",
        password,
      }),
    );
    expect(response.ok).toBe(false);
    expect((await getDb().query('SELECT count(*) FROM "user"')).rows).toEqual(
      before,
    );
  });
  it("separates lists, search, duplicate detection and receipts even for the same request ID", async () => {
    const body = input();
    const first = await save(ownerCookie, body);
    const empty = await handleCardRequest(
      request("/api/cards?q=river", secondCookie),
    );
    expect(await empty.json()).toMatchObject({ total: 0, cards: [] });
    const other = await save(secondCookie, body);
    expect(other.outcome).toBe("created");
    expect(other.cardId).not.toBe(first.cardId);
    for (const [cookie, id] of [
      [ownerCookie, first.cardId],
      [secondCookie, other.cardId],
    ]) {
      const list = await handleCardRequest(
        request("/api/cards?q=river", cookie),
      );
      const result = await list.json();
      expect(result.total).toBe(1);
      expect(result.cards.map((c: { id: string }) => c.id)).toEqual([id]);
      expect((await save(cookie, body)).cardId).toBe(id);
      expect((await save(cookie)).outcome).toBe("duplicate");
    }
  });
  it("blocks cross-account reads and every card mutation in both directions", async () => {
    const first = await save(ownerCookie);
    const other = await save(secondCookie);
    for (const [cookie, foreign] of [
      [ownerCookie, other],
      [secondCookie, first],
    ]) {
      const path = "/api/cards/" + foreign.cardId;
      expect(
        (await handleCardRequest(request(path, cookie), foreign.cardId)).status,
      ).toBe(404);
      for (const action of [
        "edit",
        "archive",
        "restore",
        "delete",
        "reset",
        "undo",
      ]) {
        const body = {
          requestId: crypto.randomUUID(),
          action,
          revision: 1,
          ...(action === "edit" ? { content: input().content } : {}),
          ...(action === "undo" ? { saveRequestId: crypto.randomUUID() } : {}),
        };
        const response = await handleCardRequest(
          request(path, cookie, body),
          foreign.cardId,
        );
        expect(response.status).toBe(404);
      }
    }
    expect((await getDb().query("SELECT revision FROM cards")).rows).toEqual([
      { revision: 1 },
      { revision: 1 },
    ]);
  });
  it("isolates active review queues, all review actions, schedules and daily progress", async () => {
    await save(ownerCookie);
    await save(secondCookie);
    const first = await today(ownerCookie, { action: "start" });
    const other = await today(secondCookie, { action: "start" });
    expect(first.session.id).not.toBe(other.session.id);
    const item = first.session.item;
    for (const [cookie, foreign] of [
      [ownerCookie, other],
      [secondCookie, first],
    ]) {
      for (const action of ["check", "reveal", "finalize"]) {
        const response = await handleReviewRequest(
          request("/api/reviews", cookie, {
            action,
            itemId: foreign.session.item.id,
            ...(action === "check" ? { answer: "river" } : {}),
            ...(action === "finalize" ? { decision: "again" } : {}),
          }),
        );
        expect(response.status).toBe(404);
      }
      // Ending an unknown/foreign queue is a safe no-op, not a way to close it.
      await today(cookie, { action: "end", sessionId: foreign.session.id });
    }
    expect((await today(secondCookie)).session.id).toBe(other.session.id);
    expect((await today(ownerCookie)).session.id).toBe(first.session.id);
    await today(ownerCookie, { action: "reveal", itemId: item.id });
    expect(
      await today(ownerCookie, {
        action: "finalize",
        itemId: item.id,
        decision: "good",
      }),
    ).toMatchObject({ completed: 1, attempts: 1 });
    expect(await today(secondCookie)).toMatchObject({
      completed: 0,
      attempts: 0,
      session: { id: other.session.id },
    });
    const untouched = await getDb().query(
      "SELECT r.revision FROM review_schedules r JOIN cards c ON c.id=r.card_id WHERE c.owner_id=$1",
      [second],
    );
    expect(untouched.rows).toEqual([{ revision: 1 }, { revision: 1 }]);
  });
  it("keeps translation quotas per account", async () => {
    expect(await reserveTranslation(getDb(), owner, 1)).toBe(true);
    expect(await reserveTranslation(getDb(), owner, 1)).toBe(false);
    expect(await reserveTranslation(getDb(), second, 1)).toBe(true);
    expect(await reserveTranslation(getDb(), second, 1)).toBe(false);
  });
  it("rejects authenticated identities without a provisioned workspace", async () => {
    const id = await createAccount(getDb(), "unprovisioned", password);
    const cookie = await signIn("unprovisioned");
    await getDb().query("DELETE FROM owner_preferences WHERE owner_id=$1", [
      id,
    ]);
    expect(await ownerSession(new Headers({ cookie }))).toBeNull();
    expect(
      (await handleCardRequest(request("/api/cards", cookie))).status,
    ).toBe(401);
    expect(
      (await handleReviewRequest(request("/api/reviews", cookie))).status,
    ).toBe(401);
  });
});
