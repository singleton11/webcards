import { z } from "zod";
import { ownerSession } from "./auth";
import { getConfig } from "./config";
import { getDb } from "./db";
import {
  CardError,
  saveCardSchema,
  cardCommandSchema,
  cardQuerySchema,
} from "./card-contracts";
import { changeCard, getCard, listCards, saveCard } from "./cards";

function reply(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}
export async function readJson(request: Request) {
  if (
    request.headers.get("content-type")?.split(";")[0].trim() !==
    "application/json"
  )
    throw new CardError(415, "content_type", "Expected JSON.");
  const reader = request.body?.getReader();
  if (!reader)
    throw new CardError(400, "invalid_body", "A request body is required.");
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 16384) {
        await reader.cancel();
        throw new CardError(413, "too_large", "Request is too large.");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch {
      throw new CardError(400, "invalid_json", "Invalid JSON.");
    }
  } finally {
    reader.releaseLock();
  }
}
export async function handleCardRequest(request: Request, id?: string) {
  try {
    if (
      request.method !== "GET" &&
      request.headers.get("origin") !==
        new URL(getConfig().BETTER_AUTH_URL).origin
    )
      throw new CardError(403, "origin", "Untrusted origin.");
    const session = await ownerSession(request.headers);
    if (!session)
      throw new CardError(
        401,
        "unauthorized",
        "Please sign in again to access your vocabulary.",
      );
    const owner = session.user.id;
    if (id && !z.uuid().safeParse(id).success)
      throw new CardError(
        404,
        "not_found",
        "This card is no longer available.",
      );
    if (request.method === "GET") {
      if (id) {
        const card = await getCard(getDb(), owner, id);
        if (!card)
          throw new CardError(
            404,
            "not_found",
            "This card is no longer available.",
          );
        return reply({ card });
      }
      const query = cardQuerySchema.parse(
        Object.fromEntries(new URL(request.url).searchParams),
      );
      return reply(await listCards(getDb(), owner, query));
    }
    if (request.method === "POST") {
      const json = await readJson(request);
      return reply(
        id
          ? await changeCard(getDb(), owner, id, cardCommandSchema.parse(json))
          : await saveCard(getDb(), owner, saveCardSchema.parse(json)),
      );
    }
    return reply({ error: "Method not allowed." }, 405);
  } catch (error) {
    if (error instanceof CardError)
      return reply({ error: error.message, code: error.code }, error.status);
    if (error instanceof z.ZodError)
      return reply(
        {
          error:
            "Check both language sides, meaning and context, or reload the card and try again.",
          code: "validation",
        },
        400,
      );
    console.error(
      JSON.stringify({ event: "card_error", category: "internal" }),
    );
    return reply(
      {
        error:
          "Vocabulary is temporarily unavailable. Retry the same action to check whether it was saved.",
      },
      503,
    );
  }
}
