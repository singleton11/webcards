import { createHash } from "node:crypto";
import type { Pool } from "pg";
const migrations = [
  {
    version: "0001_owner_foundations",
    sql: `CREATE TABLE owner_preferences (
    owner_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
    timezone text NOT NULL DEFAULT 'UTC',
    daily_goal integer NOT NULL DEFAULT 12 CHECK (daily_goal > 0)
  );
  CREATE TABLE translation_usage (
    owner_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    day date NOT NULL,
    requests integer NOT NULL DEFAULT 0 CHECK (requests >= 0),
    PRIMARY KEY (owner_id, day)
  );`,
  },
  {
    version: "0002_vocabulary",
    sql: `CREATE TABLE cards (
      id uuid PRIMARY KEY,
      owner_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
      revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
      current_version integer NOT NULL DEFAULT 1 CHECK (current_version > 0),
      fingerprint text NOT NULL,
      original_source text NOT NULL CHECK (original_source IN ('ru','en')),
      model text NOT NULL,
      prompt_version text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX cards_active_fingerprint ON cards (owner_id, fingerprint) WHERE status='active';
    CREATE INDEX cards_owner_list ON cards (owner_id, status, created_at DESC, id);
    CREATE TABLE card_versions (
      card_id uuid NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      version integer NOT NULL CHECK (version > 0),
      russian text NOT NULL,
      english text NOT NULL,
      sense text NOT NULL,
      context text NOT NULL,
      note text NOT NULL,
      search_text text NOT NULL,
      origin text NOT NULL CHECK (origin IN ('translation','owner_edit')),
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (card_id, version)
    );
    ALTER TABLE cards ADD CONSTRAINT cards_current_version_fk
      FOREIGN KEY (id, current_version) REFERENCES card_versions(card_id, version)
      DEFERRABLE INITIALLY DEFERRED;
    -- Receipts retain hashes and IDs only, so deletion cannot leave card text here.
    CREATE TABLE card_receipts (
      owner_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      request_id uuid NOT NULL,
      payload_hash text NOT NULL,
      card_id uuid NOT NULL,
      outcome text NOT NULL,
      revision integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (owner_id, request_id)
    );`,
  },
  {
    version: "0003_daily_review",
    sql: `CREATE TABLE review_schedules (
      card_id uuid NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      direction text NOT NULL CHECK (direction IN ('ru-en','en-ru')),
      revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
      due_at timestamptz NOT NULL,
      state jsonb NOT NULL,
      PRIMARY KEY (card_id, direction)
    );
    CREATE INDEX review_schedule_due ON review_schedules (due_at);
    CREATE TABLE review_sessions (
      id uuid PRIMARY KEY,
      owner_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX review_one_active_session ON review_sessions(owner_id) WHERE active;
    CREATE TABLE review_items (
      id uuid PRIMARY KEY,
      session_id uuid NOT NULL REFERENCES review_sessions(id) ON DELETE CASCADE,
      card_id uuid NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      card_version integer NOT NULL,
      direction text NOT NULL CHECK (direction IN ('ru-en','en-ru')),
      schedule_revision integer NOT NULL,
      position integer NOT NULL,
      available_at timestamptz NOT NULL,
      answer text,
      grade jsonb,
      revealed boolean NOT NULL DEFAULT false,
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','finalized','skipped')),
      result jsonb,
      UNIQUE(session_id,position),
      FOREIGN KEY (card_id,card_version) REFERENCES card_versions(card_id,version) ON DELETE CASCADE
    );
    CREATE TABLE review_introductions (
      card_id uuid PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
      introduced_at timestamptz NOT NULL
    );
    CREATE TABLE review_events (
      attempt_id uuid PRIMARY KEY REFERENCES review_items(id) ON DELETE CASCADE,
      owner_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      card_id uuid NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      card_version integer NOT NULL,
      direction text NOT NULL CHECK (direction IN ('ru-en','en-ru')),
      answer text,
      grade jsonb NOT NULL,
      rating text NOT NULL CHECK (rating IN ('good','again')),
      source text NOT NULL CHECK (source IN ('automatic','self')),
      reviewed_at timestamptz NOT NULL,
      before_state jsonb NOT NULL,
      after_state jsonb NOT NULL,
      scheduler_version text NOT NULL,
      scheduler_parameters jsonb NOT NULL,
      FOREIGN KEY (card_id,card_version) REFERENCES card_versions(card_id,version) ON DELETE CASCADE
    );
    CREATE INDEX review_events_owner_time ON review_events(owner_id,reviewed_at);
    CREATE TABLE grading_usage (
      owner_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      day date NOT NULL,
      requests integer NOT NULL CHECK (requests >= 0),
      PRIMARY KEY(owner_id,day)
    );`,
  },
];
export async function migrateApplication(db: Pool) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(78289014)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const migration of migrations) {
      const checksum = createHash("sha256").update(migration.sql).digest("hex");
      const applied = await client.query(
        "SELECT checksum FROM schema_migrations WHERE version=$1",
        [migration.version],
      );
      if (applied.rowCount) {
        if (applied.rows[0].checksum !== checksum)
          throw new Error(
            "Applied migration checksum mismatch: " + migration.version,
          );
        continue;
      }
      await client.query(migration.sql);
      await client.query(
        "INSERT INTO schema_migrations (version, checksum) VALUES ($1,$2)",
        [migration.version, checksum],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
