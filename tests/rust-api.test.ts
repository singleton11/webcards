import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { createApi } from "../src/api";
import { getDb } from "../src/lib/db";
import { createAccount, createOwner, migrate } from "../src/lib/persistence";
import { saveCard, changeCard } from "../src/lib/cards";
import { saveCardSchema, cardCommandSchema } from "../src/lib/card-contracts";
import {
  disposablePostgres,
  freePort,
  testEnvironment,
} from "./helpers/postgres";

let pg: Awaited<ReturnType<typeof disposablePostgres>>;
let api: ChildProcess;
let model: Server;
let endpoint: string;
let origin: string;
let owner: string;
let calls = 0;
const password = "isolated-password-1234";
const save = {
  requestId: "c1653094-ef84-4a1c-988f-ce2fd53a1353",
  source: "en" as const,
  model: "chatgpt-gpt-6-luna" as const,
  promptVersion: "translation-v1",
  content: {
    russian: "река",
    english: "river",
    sense: "watercourse",
    context: "",
    note: "",
  },
};
let cookie: string;
let reviewed: { cardId: string; direction: string; itemId: string };
async function request(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  headers.set("origin", origin);
  if (cookie) headers.set("cookie", cookie);
  if (options.body) headers.set("content-type", "application/json");
  return fetch(endpoint + path, { ...options, headers });
}
async function nodeRequest(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  headers.set("origin", origin);
  if (cookie) headers.set("cookie", cookie);
  if (options.body) headers.set("content-type", "application/json");
  return createApi().request(origin + path, { ...options, headers });
}
const post = (value: unknown) => ({
  method: "POST",
  body: JSON.stringify(value),
});

beforeAll(async () => {
  pg = await disposablePostgres();
  origin = "http://127.0.0.1:3000";
  testEnvironment(pg.url, origin);
  process.env.WEBCARDS_E2E_FIXTURE = "1";
  process.env.NODE_ENV = "test";
  model = createServer(async (req, res) => {
    calls++;
    let text = "";
    for await (const chunk of req) text += chunk;
    const payload = JSON.parse(text);
    await delay(250);
    const body =
      payload.text.format.name === "grading"
        ? { verdict: "correct", reason: "Fixture judgment.", correction: null }
        : {
            status: "ok",
            alternatives: [
              { translation: "река", sense: "watercourse", note: "" },
            ],
            clarification: null,
          };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: JSON.stringify(body) }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  const port = (model.address() as { port: number }).port;
  process.env.LITELLM_BASE_URL = `http://127.0.0.1:${port}/v1`;
  const db = getDb();
  await migrate(db);
  owner = await createOwner(db, "owner", password);
  await createAccount(db, "second", password);
  await createAccount(db, "stress", password);
  const apiPort = await freePort();
  endpoint = `http://127.0.0.1:${apiPort}`;
  api = spawn("./dist/webcards-api", [], {
    env: { ...process.env, PORT: String(apiPort) },
    stdio: "pipe",
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(endpoint + "/api/session")).ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error("Rust API did not start");
}, 120000);
afterAll(async () => {
  if (api?.exitCode === null) {
    const exit = new Promise<void>((resolve) =>
      api.once("exit", () => resolve()),
    );
    api.kill("SIGTERM");
    await exit;
  }
  await new Promise<void>(
    (resolve) => model?.close(() => resolve()) ?? resolve(),
  );
  await getDb().end();
  pg?.stop();
}, 30000);

describe.sequential(
  "Rust compatibility against the existing PostgreSQL schema",
  () => {
    it("accepts Node-created signed sessions and rejects forged cookies", async () => {
      const login = await nodeRequest(
        "/api/auth/sign-in/username",
        post({ username: "owner", password }),
      );
      expect(login.status).toBe(200);
      cookie = login.headers.get("set-cookie")!.split(";")[0];
      const session = await request("/api/session");
      expect(await session.json()).toEqual({ authenticated: true });
      const bad = await fetch(endpoint + "/api/session", {
        headers: { cookie: cookie + "forged" },
      });
      expect(await bad.json()).toEqual({ authenticated: false });
      const csrf = await fetch(endpoint + "/api/auth/sign-in/username", {
        ...post({ username: "owner", password }),
        headers: {
          origin: "http://attacker.invalid",
          "content-type": "application/json",
        },
      });
      expect(csrf.status).toBe(403);
      expect(
        (
          await request(
            "/api/auth/sign-up/email",
            post({ email: "a@b.c", password }),
          )
        ).status,
      ).toBe(404);
    });
    it("matches Node's active-card total independently of due dates, archives and other accounts", async () => {
      const db = getDb();
      const second = (
        await db.query('SELECT id FROM "user" WHERE username=$1', ["second"])
      ).rows[0].id;
      expect(await (await request("/api/reviews")).json()).toMatchObject({
        totalCards: 0,
      });
      const ids: string[] = [];
      try {
        for (const [index, asOwner] of [owner, owner, second].entries()) {
          const saved = await saveCard(
            db,
            asOwner,
            saveCardSchema.parse({
              ...save,
              requestId: crypto.randomUUID(),
              content: { ...save.content, english: `count fixture ${index}` },
            }),
          );
          ids.push(saved.cardId);
        }
        await request("/api/reviews");
        await db.query(
          "UPDATE review_schedules SET due_at=now()+interval '100 days' WHERE card_id=ANY($1::uuid[])",
          [ids],
        );
        const counts = async (totalCards: number) => {
          const rust = await (await request("/api/reviews")).json();
          const node = await (await nodeRequest("/api/reviews")).json();
          expect(rust).toEqual(node);
          expect(rust).toMatchObject({
            totalCards,
            dueCards: 0,
            dueDirections: 0,
          });
        };
        await counts(2);
        await changeCard(db, owner, ids[1], {
          action: "archive",
          revision: 1,
          requestId: crypto.randomUUID(),
        });
        await counts(1);
        await changeCard(db, owner, ids[1], {
          action: "restore",
          revision: 2,
          requestId: crypto.randomUUID(),
        });
        await counts(2);
        await changeCard(db, owner, ids[0], {
          action: "delete",
          revision: 1,
          requestId: crypto.randomUUID(),
        });
        await counts(1);
      } finally {
        await db.query("DELETE FROM cards WHERE id=ANY($1::uuid[])", [ids]);
      }
    });
    it("keeps Node and Rust save, edit and receipt replay interoperable", async () => {
      const db = getDb();
      const original = await saveCard(db, owner, saveCardSchema.parse(save));
      expect(original.outcome).toBe("created");
      const replay = await request("/api/cards", post(save));
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({
        cardId: original.cardId,
        outcome: "created",
      });
      const second = {
        ...save,
        requestId: crypto.randomUUID(),
        content: {
          ...save.content,
          english: "stream",
          russian: "ручей",
          sense: "water stream",
        },
      };
      const rustSave = await request("/api/cards", post(second));
      expect(rustSave.status).toBe(200);
      const rustCard = await rustSave.json();
      expect(
        (await saveCard(db, owner, saveCardSchema.parse(second))).cardId,
      ).toBe(rustCard.cardId);
      const edit = {
        action: "edit" as const,
        requestId: crypto.randomUUID(),
        revision: 1,
        content: { ...save.content, note: "Node edit" },
      };
      expect(
        (
          await changeCard(
            db,
            owner,
            original.cardId,
            cardCommandSchema.parse(edit),
          )
        ).outcome,
      ).toBe("updated");
      const retryEdit = await request(
        "/api/cards/" + original.cardId,
        post(edit),
      );
      expect(retryEdit.status).toBe(200);
      expect(await retryEdit.json()).toMatchObject({
        outcome: "updated",
        revision: 2,
      });
      const conflict = await request(
        "/api/cards",
        post({ ...save, content: { ...save.content, english: "changed" } }),
      );
      expect(conflict.status).toBe(409);
      expect((await conflict.json()).code).toBe("request_conflict");
    });
    it("coalesces concurrent translations and rejects conflicting replays", async () => {
      const input = {
        requestId: crypto.randomUUID(),
        source: "en",
        target: "ru",
        text: "river",
        context: "",
      };
      const previous = calls;
      const first = request("/api/translate", post(input));
      for (let i = 0; calls === previous && i < 100; i++) await delay(10);
      expect(calls - previous).toBe(1);
      const [a, b, conflict] = await Promise.all([
        first,
        request("/api/translate", post(input)),
        request("/api/translate", post({ ...input, text: "different" })),
      ]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(conflict.status).toBe(409);
      expect(await a.json()).toEqual(await b.json());
      expect(calls - previous).toBe(1);
      const replay = await request("/api/translate", post(input));
      expect(replay.status).toBe(200);
      expect(calls - previous).toBe(1);
    });
    it("finishes an in-flight translation when the initiating client disconnects", async () => {
      const input = {
        requestId: crypto.randomUUID(),
        source: "en",
        target: "ru",
        text: "disconnected client",
        context: "",
      };
      const previous = calls;
      const abort = new AbortController();
      const first = request("/api/translate", {
        ...post(input),
        signal: abort.signal,
      }).catch(() => null);
      for (let i = 0; calls === previous && i < 100; i++) await delay(10);
      expect(calls - previous).toBe(1);
      abort.abort();
      await first;
      const retry = await request("/api/translate", post(input));
      expect(retry.status).toBe(200);
      expect(calls - previous).toBe(1);
    });
    it("finalizes once, maintains direction schedules, and isolates accounts", async () => {
      const started = await request("/api/reviews", post({ action: "start" }));
      expect(started.status).toBe(200);
      const question = (await started.json()).session.item;
      const answer = "a model-checked alternative";
      const check = { action: "check", itemId: question.id, answer };
      const previous = calls;
      const first = request("/api/reviews", post(check));
      for (let i = 0; calls === previous && i < 100; i++) await delay(10);
      expect(calls - previous).toBe(1);
      const [checked, retried, conflict] = await Promise.all([
        first,
        request("/api/reviews", post(check)),
        request("/api/reviews", post({ ...check, answer: "different answer" })),
      ]);
      expect([checked.status, retried.status, conflict.status]).toEqual([
        200, 200, 409,
      ]);
      expect(calls - previous).toBe(1);
      const action = {
        action: "finalize",
        itemId: question.id,
        decision: "accept",
      };
      const [a, b] = await Promise.all([
        request("/api/reviews", post(action)),
        request("/api/reviews", post(action)),
      ]);
      expect([a.status, b.status]).toEqual([200, 200]);
      const events = await getDb().query(
        "SELECT * FROM review_events WHERE attempt_id=$1",
        [question.id],
      );
      expect(events.rowCount).toBe(1);
      expect(events.rows[0].after_state.state).toBe(2);
      reviewed = {
        cardId: question.cardId,
        direction: question.direction,
        itemId: question.id,
      };
      expect(
        (await request("/api/reviews", post({ ...action, decision: "again" })))
          .status,
      ).toBe(409);
      const login = await request(
        "/api/auth/sign-in/username",
        post({ username: "second", password }),
      );
      expect(login.status).toBe(200);
      const secondCookie = login.headers.get("set-cookie")!.split(";")[0];
      expect(
        (
          await fetch(endpoint + "/api/cards/" + question.cardId, {
            headers: { cookie: secondCookie },
          })
        ).status,
      ).toBe(404);
      const secondToday = await fetch(endpoint + "/api/reviews", {
        headers: { cookie: secondCookie },
      });
      expect(secondToday.status).toBe(200);
      expect(await secondToday.json()).toMatchObject({ totalCards: 0 });
    });
    it("lets the Node API continue an FSRS schedule written by Rust", async () => {
      const db = getDb();
      const current = await nodeRequest("/api/reviews");
      expect(current.status).toBe(200);
      const today = await current.json();
      if (today.session)
        expect(
          (
            await nodeRequest(
              "/api/reviews",
              post({ action: "end", sessionId: today.session.id }),
            )
          ).status,
        ).toBe(200);
      const rustState = (
        await db.query(
          "SELECT after_state FROM review_events WHERE attempt_id=$1",
          [reviewed.itemId],
        )
      ).rows[0].after_state;
      await db.query(
        "UPDATE review_events SET reviewed_at=now()-interval '1 day' WHERE attempt_id=$1",
        [reviewed.itemId],
      );
      await db.query(
        "UPDATE cards SET status='archived' WHERE owner_id=$1 AND id<>$2",
        [owner, reviewed.cardId],
      );
      await db.query(
        "UPDATE review_schedules SET due_at=CASE WHEN direction=$2 THEN now()-interval '1 day' ELSE now()+interval '100 days' END WHERE card_id=$1",
        [reviewed.cardId, reviewed.direction],
      );
      const start = await nodeRequest(
        "/api/reviews",
        post({ action: "start" }),
      );
      expect(start.status).toBe(200);
      const question = (await start.json()).session.item;
      expect(question).toMatchObject({
        cardId: reviewed.cardId,
        direction: reviewed.direction,
      });
      const card = (
        await (await nodeRequest("/api/cards/" + question.cardId)).json()
      ).card.content;
      const answer =
        question.direction === "ru-en" ? card.english : card.russian;
      expect(
        (
          await nodeRequest(
            "/api/reviews",
            post({ action: "check", itemId: question.id, answer }),
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await nodeRequest(
            "/api/reviews",
            post({
              action: "finalize",
              itemId: question.id,
              decision: "accept",
            }),
          )
        ).status,
      ).toBe(200);
      const next = (
        await db.query(
          "SELECT before_state,after_state FROM review_events WHERE attempt_id=$1",
          [question.id],
        )
      ).rows[0];
      expect(next.before_state).toEqual(rustState);
      expect(next.after_state.reps).toBe(rustState.reps + 1);
    });
    it("queues more than 200 cards and schedules mistakes for the next local day", async () => {
      const db = getDb();
      const stress = (
        await db.query('SELECT id FROM "user" WHERE username=$1', ["stress"])
      ).rows[0].id;
      await db.query(
        "UPDATE owner_preferences SET timezone='Europe/Amsterdam' WHERE owner_id=$1",
        [stress],
      );
      for (let i = 0; i < 205; i++) {
        await saveCard(
          db,
          stress,
          saveCardSchema.parse({
            ...save,
            requestId: crypto.randomUUID(),
            content: {
              ...save.content,
              english: `word ${i}`,
              russian: `слово ${i}`,
            },
          }),
        );
      }
      const login = await request(
        "/api/auth/sign-in/username",
        post({ username: "stress", password }),
      );
      expect(login.status).toBe(200);
      const oldCookie = cookie;
      cookie = login.headers.get("set-cookie")!.split(";")[0];
      const result = await request("/api/reviews", post({ action: "start" }));
      expect(result.status).toBe(200);
      const today = await result.json();
      expect(today).toMatchObject({
        timezone: "Europe/Amsterdam",
        dueCards: 205,
        dueDirections: 410,
        totalCards: 205,
        session: { remaining: 205 },
      });
      const itemId = today.session.item.id;
      expect(
        (await request("/api/reviews", post({ action: "reveal", itemId })))
          .status,
      ).toBe(200);
      const finalized = await request(
        "/api/reviews",
        post({ action: "finalize", itemId, decision: "again" }),
      );
      expect(finalized.status).toBe(200);
      const row = (
        await db.query(
          `SELECT after_state->>'due' AS due, ((reviewed_at AT TIME ZONE 'Europe/Amsterdam')::date + 1)::timestamp AT TIME ZONE 'Europe/Amsterdam' AS tomorrow FROM review_events WHERE attempt_id=$1`,
          [itemId],
        )
      ).rows[0];
      expect(new Date(row.due).getTime()).toBe(row.tomorrow.getTime());
      expect((await finalized.json()).completed).toBe(1);
      cookie = oldCookie;
    }, 30000);
    it("renews an existing Node session without changing its token", async () => {
      const db = getDb();
      await db.query(
        'UPDATE session SET "updatedAt"=now()-interval \'2 days\',"expiresAt"=now()+interval \'1 day\' WHERE "userId"=$1',
        [owner],
      );
      const response = await request("/api/session");
      expect(await response.json()).toEqual({ authenticated: true });
      expect(response.headers.get("set-cookie")).toContain("Max-Age=");
      const row = (
        await db.query(
          'SELECT "expiresAt" FROM session WHERE "userId"=$1 ORDER BY "updatedAt" DESC LIMIT 1',
          [owner],
        )
      ).rows[0];
      expect(row.expiresAt.getTime() - Date.now()).toBeGreaterThan(
        6 * 24 * 60 * 60 * 1000,
      );
    });
    it("allows Node to read and revoke a Rust-issued session", async () => {
      const login = await request(
        "/api/auth/sign-in/username",
        post({ username: "owner", password }),
      );
      expect(login.status).toBe(200);
      cookie = login.headers.get("set-cookie")!.split(";")[0];
      const node = await nodeRequest("/api/session");
      expect(await node.json()).toEqual({ authenticated: true });
      expect((await nodeRequest("/api/auth/sign-out", post({}))).status).toBe(
        200,
      );
      expect(await (await request("/api/session")).json()).toEqual({
        authenticated: false,
      });
    });
  },
);
