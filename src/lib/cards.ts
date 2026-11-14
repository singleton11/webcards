import { createHash, createHmac, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { getConfig } from "./config";
import { emptySchedule } from "./scheduler";
import {
  CardError,
  normalizeCardText,
  type Card,
  type CardContent,
  type CardCommand,
  type CardQuery,
  type CardResult,
  type CardOutcome,
  type SaveCardInput,
  type CardList,
} from "./card-contracts";

type Database = Pick<Pool, "query"> | Pick<PoolClient, "query">;
function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function cardFingerprint(content: CardContent) {
  return hash(
    [content.russian, content.english, content.sense, content.context].map(
      normalizeCardText,
    ),
  );
}
const selection = `SELECT c.id, c.status, c.revision, c.current_version AS version,
  c.original_source AS source, c.model, c.prompt_version AS "promptVersion",
  c.created_at AS "createdAt", c.updated_at AS "updatedAt",
  json_build_object('russian',v.russian,'english',v.english,'sense',v.sense,
    'context',v.context,'note',v.note) AS content
  FROM cards c JOIN card_versions v ON v.card_id=c.id AND v.version=c.current_version`;
function toCard(row: Record<string, unknown>): Card {
  return {
    ...row,
    createdAt: (row.createdAt as Date).toISOString(),
    updatedAt: (row.updatedAt as Date).toISOString(),
  } as Card;
}
export async function getCard(
  db: Database,
  owner: string,
  id: string,
): Promise<Card | null> {
  const result = await db.query(
    selection + " WHERE c.owner_id=$1 AND c.id=$2",
    [owner, id],
  );
  return result.rows[0] ? toCard(result.rows[0]) : null;
}
export async function listCards(
  db: Database,
  owner: string,
  query: CardQuery,
): Promise<CardList> {
  const pageSize = 50;
  const values = [owner, query.status, query.q.toLowerCase()];
  const where =
    " WHERE c.owner_id=$1 AND c.status=$2 AND ($3='' OR strpos(v.search_text,$3)>0)";
  const rows = await db.query(
    selection + where + " ORDER BY c.created_at DESC, c.id LIMIT $4 OFFSET $5",
    [...values, pageSize, (query.page - 1) * pageSize],
  );
  const total = await db.query(
    "SELECT count(*)::integer AS total FROM cards c JOIN card_versions v ON v.card_id=c.id AND v.version=c.current_version" +
      where,
    values,
  );
  return {
    cards: rows.rows.map(toCard),
    total: total.rows[0].total,
    page: query.page,
    pageSize,
  };
}
async function writeVersion(
  client: PoolClient,
  id: string,
  version: number,
  content: CardContent,
  origin: string,
) {
  await client.query(
    `INSERT INTO card_versions (card_id,version,russian,english,sense,context,note,search_text,origin)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      id,
      version,
      content.russian,
      content.english,
      content.sense,
      content.context,
      content.note,
      Object.values(content).join(" ").toLowerCase(),
      origin,
    ],
  );
}
async function duplicate(
  client: PoolClient,
  owner: string,
  fingerprint: string,
  except?: string,
) {
  const result = await client.query(
    "SELECT id FROM cards WHERE owner_id=$1 AND fingerprint=$2 AND status='active' AND ($3::uuid IS NULL OR id<>$3)",
    [owner, fingerprint, except ?? null],
  );
  return result.rows[0]?.id as string | undefined;
}
async function transact(
  db: Pool,
  owner: string,
  requestId: string,
  payload: unknown,
  run: (
    client: PoolClient,
  ) => Promise<{ id: string; outcome: CardOutcome; revision: number }>,
): Promise<CardResult> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // Serialize this owner's short writes, including receipt checks and uniqueness changes.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,7422026))",
      [owner],
    );
    const payloadHash = createHmac("sha256", getConfig().BETTER_AUTH_SECRET)
      .update("webcards-card-receipt-v1\0")
      .update(JSON.stringify(payload))
      .digest("hex");
    const receipt = await client.query(
      "SELECT * FROM card_receipts WHERE owner_id=$1 AND request_id=$2",
      [owner, requestId],
    );
    let result: { id: string; outcome: CardOutcome; revision: number };
    if (receipt.rows[0]) {
      const saved = receipt.rows[0];
      if (saved.payload_hash !== payloadHash)
        throw new CardError(
          409,
          "request_conflict",
          "This request ID was already used for another change.",
        );
      result = {
        id: saved.card_id,
        outcome: saved.outcome,
        revision: saved.revision,
      };
    } else {
      result = await run(client);
      await client.query(
        `INSERT INTO card_receipts (owner_id,request_id,payload_hash,card_id,outcome,revision)
        VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          owner,
          requestId,
          payloadHash,
          result.id,
          result.outcome,
          result.revision,
        ],
      );
    }
    const card = await getCard(client, owner, result.id);
    await client.query("COMMIT");
    return {
      card,
      cardId: result.id,
      outcome: result.outcome,
      revision: result.revision,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export function saveCard(db: Pool, owner: string, input: SaveCardInput) {
  return transact(
    db,
    owner,
    input.requestId,
    { action: "save", ...input },
    async (client) => {
      const fingerprint = cardFingerprint(input.content);
      const existing = await duplicate(client, owner, fingerprint);
      if (existing) {
        const card = (await getCard(client, owner, existing))!;
        return { id: existing, outcome: "duplicate", revision: card.revision };
      }
      const id = randomUUID();
      await client.query(
        `INSERT INTO cards (id,owner_id,fingerprint,original_source,model,prompt_version)
      VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          id,
          owner,
          fingerprint,
          input.source,
          input.model,
          input.promptVersion,
        ],
      );
      await writeVersion(client, id, 1, input.content, "translation");
      return { id, outcome: "created", revision: 1 };
    },
  );
}
export function changeCard(
  db: Pool,
  owner: string,
  id: string,
  command: CardCommand,
) {
  return transact(
    db,
    owner,
    command.requestId,
    { id, ...command },
    async (client) => {
      const card = await getCard(client, owner, id);
      if (!card)
        throw new CardError(
          404,
          "not_found",
          "This card is no longer available.",
        );
      if (card.revision !== command.revision)
        throw new CardError(
          409,
          "stale_card",
          "This card changed in another tab or device. Reload it before making another change.",
        );
      if (command.action === "undo") {
        const saved = await client.query(
          `SELECT card_id,outcome FROM card_receipts
        WHERE owner_id=$1 AND request_id=$2`,
          [owner, command.saveRequestId],
        );
        if (
          saved.rows[0]?.card_id !== id ||
          saved.rows[0]?.outcome !== "created" ||
          card.revision !== 1
        )
          throw new CardError(
            409,
            "cannot_undo",
            "Undo is only available for your new, unchanged save. Manage this card in My list instead.",
          );
        await client.query("DELETE FROM cards WHERE owner_id=$1 AND id=$2", [
          owner,
          id,
        ]);
        return { id, outcome: "undone", revision: card.revision };
      }
      if (command.action === "delete") {
        await client.query("DELETE FROM cards WHERE owner_id=$1 AND id=$2", [
          owner,
          id,
        ]);
        return { id, outcome: "deleted", revision: card.revision };
      }
      if (command.action === "reset") {
        const now = new Date();
        await client.query(
          `INSERT INTO review_schedules(card_id,direction,due_at,state)
          SELECT $1,d.direction,$2,$3::jsonb FROM (VALUES ('ru-en'),('en-ru')) d(direction)
          ON CONFLICT(card_id,direction) DO UPDATE SET due_at=EXCLUDED.due_at,
          state=EXCLUDED.state,revision=review_schedules.revision+1`,
          [id, now, JSON.stringify(emptySchedule(now))],
        );
        await client.query(
          "UPDATE cards SET revision=revision+1,updated_at=now() WHERE owner_id=$1 AND id=$2",
          [owner, id],
        );
        return { id, outcome: "reset", revision: card.revision + 1 };
      }
      if (command.action === "edit") {
        if (JSON.stringify(card.content) === JSON.stringify(command.content))
          return { id, outcome: "unchanged", revision: card.revision };
        const fingerprint = cardFingerprint(command.content);
        if (
          card.status === "active" &&
          (await duplicate(client, owner, fingerprint, id))
        )
          throw new CardError(
            409,
            "duplicate_card",
            "An active card already has this meaning and context. No changes were saved.",
          );
        await writeVersion(
          client,
          id,
          card.version + 1,
          command.content,
          "owner_edit",
        );
        await client.query(
          `UPDATE cards SET current_version=current_version+1, revision=revision+1,
        fingerprint=$3, updated_at=now() WHERE owner_id=$1 AND id=$2`,
          [owner, id, fingerprint],
        );
        return { id, outcome: "updated", revision: card.revision + 1 };
      }
      const status = command.action === "archive" ? "archived" : "active";
      if (card.status === status)
        return { id, outcome: "unchanged", revision: card.revision };
      if (
        status === "active" &&
        (await duplicate(client, owner, cardFingerprint(card.content), id))
      )
        throw new CardError(
          409,
          "duplicate_card",
          "An active card already has this meaning and context. The archived card was not restored.",
        );
      await client.query(
        "UPDATE cards SET status=$3,revision=revision+1,updated_at=now() WHERE owner_id=$1 AND id=$2",
        [owner, id, status],
      );
      return {
        id,
        outcome: command.action === "archive" ? "archived" : "restored",
        revision: card.revision + 1,
      };
    },
  );
}
