import { getMigrations } from "better-auth/db/migration";
import { hashPassword } from "better-auth/crypto";
import type { Pool } from "pg";
import { authOptions } from "./auth";
import { migrateApplication } from "./migrations";
export async function migrate(db: Pool) {
  const plan = await getMigrations(authOptions(db));
  await plan.runMigrations();
  await migrateApplication(db);
}
export async function createOwner(
  db: Pool,
  username: string,
  password: string,
) {
  return provisionAccount(db, username, password, true);
}
export async function createAccount(
  db: Pool,
  username: string,
  password: string,
) {
  return provisionAccount(db, username, password, false);
}
async function provisionAccount(
  db: Pool,
  username: string,
  password: string,
  requireEmptyDatabase: boolean,
) {
  if (!/^[a-z0-9_]{3,30}$/.test(username))
    throw new Error(
      "Use a lowercase username of 3-30 letters, numbers or underscores.",
    );
  if (password.length < 12 || password.length > 128)
    throw new Error("Use a password of 12-128 characters.");
  const hashed = await hashPassword(password);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query('LOCK TABLE "user" IN EXCLUSIVE MODE');
    if (requireEmptyDatabase) {
      const existing = await client.query('SELECT id FROM "user" LIMIT 1');
      if (existing.rowCount)
        throw new Error("An owner already exists. No account was changed.");
    }
    const duplicate = await client.query(
      'SELECT id FROM "user" WHERE lower(username)=$1',
      [username],
    );
    if (duplicate.rowCount)
      throw new Error("This username already exists. No account was changed.");
    const id = crypto.randomUUID();
    await client.query(
      'INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", username, "displayUsername") VALUES ($1,$2,$3,true,now(),now(),$2,$2)',
      [id, username, username + "@owner.invalid"],
    );
    await client.query(
      `INSERT INTO account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt") VALUES ($1,$2,'credential',$2,$3,now(),now())`,
      [crypto.randomUUID(), id, hashed],
    );
    await client.query("INSERT INTO owner_preferences (owner_id) VALUES ($1)", [
      id,
    ]);
    await client.query("COMMIT");
    return id;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export async function reserveTranslation(
  db: Pool,
  ownerId: string,
  limit: number,
) {
  const result = await db.query(
    `INSERT INTO translation_usage (owner_id, day, requests)
    VALUES ($1, (now() AT TIME ZONE 'UTC')::date, 1)
    ON CONFLICT (owner_id, day) DO UPDATE SET requests = translation_usage.requests + 1
    WHERE translation_usage.requests < $2 RETURNING requests`,
    [ownerId, limit],
  );
  return result.rowCount === 1;
}
