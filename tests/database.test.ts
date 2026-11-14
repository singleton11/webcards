import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { disposablePostgres, testEnvironment } from "./helpers/postgres";
import { getDb } from "../src/lib/db";
import { authOptions, ownerSession } from "../src/lib/auth";
import { handleAuthRequest } from "../src/lib/auth-handler";
import {
  migrate,
  createOwner,
  reserveTranslation,
} from "../src/lib/persistence";
import { migrateApplication } from "../src/lib/migrations";
let postgres: Awaited<ReturnType<typeof disposablePostgres>>, ownerId: string;
const password = "isolated-password-1234";
it("keeps production sign-in limits even when the browser-fixture flag is present", () => {
  try {
    vi.stubEnv("WEBCARDS_E2E_FIXTURE", "1");
    vi.stubEnv("NODE_ENV", "production");
    expect(authOptions().rateLimit.customRules["/sign-in/username"].max).toBe(
      5,
    );
    vi.stubEnv("NODE_ENV", "development");
    expect(authOptions().rateLimit.customRules["/sign-in/username"].max).toBe(
      100,
    );
    vi.stubEnv("WEBCARDS_E2E_FIXTURE", "");
    expect(authOptions().rateLimit.customRules["/sign-in/username"].max).toBe(
      5,
    );
  } finally {
    vi.unstubAllEnvs();
  }
});
beforeAll(async () => {
  postgres = await disposablePostgres();
  testEnvironment(postgres.url);
  await migrate(getDb());
  ownerId = await createOwner(getDb(), "owner", password);
}, 30000);
afterAll(async () => {
  await getDb().end();
  postgres?.stop();
});
function authRequest(
  path: string,
  body: unknown,
  origin = "http://127.0.0.1:3000",
) {
  return handleAuthRequest(
    new Request("http://127.0.0.1:3000/api/auth" + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify(body),
    }),
  );
}
describe("PostgreSQL authentication and ownership", () => {
  it("migrates idempotently", async () => {
    await migrate(getDb());
  });
  it("stores hashed credentials and default preferences", async () => {
    const account = await getDb().query(
      'SELECT password FROM account WHERE "userId"=$1',
      [ownerId],
    );
    expect(account.rows[0].password).not.toBe(password);
    const prefs = await getDb().query(
      "SELECT daily_goal FROM owner_preferences WHERE owner_id=$1",
      [ownerId],
    );
    expect(prefs.rows[0].daily_goal).toBe(12);
  });
  it("refuses a second owner", async () => {
    await expect(createOwner(getDb(), "another", password)).rejects.toThrow(
      "already exists",
    );
  });
  it("disables public registration", async () => {
    const response = await authRequest("/sign-up/email", {
      email: "stranger@example.test",
      name: "stranger",
      username: "stranger",
      password,
    });
    expect(response.ok).toBe(false);
    expect(
      (await getDb().query('SELECT count(*) FROM "user"')).rows[0].count,
    ).toBe("1");
  });
  it("rejects an incorrect password", async () => {
    const response = await authRequest("/sign-in/username", {
      username: "owner",
      password: "wrong",
    });
    expect(response.ok).toBe(false);
  });
  it("rejects cross-origin sign-in", async () => {
    const response = await authRequest(
      "/sign-in/username",
      { username: "owner", password },
      "https://evil.test",
    );
    expect(response.status).toBe(403);
  });
  it("creates an HttpOnly session and revokes it on logout", async () => {
    const response = await authRequest("/sign-in/username", {
      username: "owner",
      password,
    });
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    const headers = new Headers({ Cookie: cookie.split(";")[0] });
    expect((await ownerSession(headers))?.user.id).toBe(ownerId);
    await handleAuthRequest(
      new Request("http://127.0.0.1:3000/api/auth/sign-out", {
        method: "POST",
        headers: {
          Cookie: cookie.split(";")[0],
          Origin: "http://127.0.0.1:3000",
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
    );
    expect(await ownerSession(headers)).toBeNull();
  });
  it("reserves quotas atomically under concurrent requests", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => reserveTranslation(getDb(), ownerId, 3)),
    );
    expect(results.filter(Boolean)).toHaveLength(3);
  });
  it("does not allow another identity to reserve usage", async () => {
    await expect(
      reserveTranslation(getDb(), "not-an-owner", 3),
    ).rejects.toThrow();
  });
  it("records and checks application migration versions", async () => {
    const applied = await getDb().query(
      "SELECT version, checksum FROM schema_migrations",
    );
    expect(applied.rows.map((row) => row.version).sort()).toEqual([
      "0001_owner_foundations",
      "0002_vocabulary",
      "0003_daily_review",
    ]);
    for (const migration of applied.rows) {
      await getDb().query(
        "UPDATE schema_migrations SET checksum='changed' WHERE version=$1",
        [migration.version],
      );
      try {
        await expect(migrateApplication(getDb())).rejects.toThrow(
          "checksum mismatch",
        );
      } finally {
        await getDb().query(
          "UPDATE schema_migrations SET checksum=$1 WHERE version=$2",
          [migration.checksum, migration.version],
        );
      }
    }
    await migrateApplication(getDb());
  });
  it("limits password attempts even with caller-supplied forwarded IPs", async () => {
    const statuses = [];
    for (let i = 0; i < 7; i++) {
      const response = await handleAuthRequest(
        new Request("http://127.0.0.1:3000/api/auth/sign-in/username", {
          method: "POST",
          headers: {
            Origin: "http://127.0.0.1:3000",
            "Content-Type": "application/json",
            "X-Forwarded-For": "198.51.100." + i,
          },
          body: JSON.stringify({ username: "owner", password: "wrong" }),
        }),
      );
      statuses.push(response.status);
    }
    expect(statuses).toContain(429);
    expect(statuses.at(-1)).toBe(429);
  });
});
