import { z } from "zod";
import { ownerSession } from "./auth";
import { readJson } from "./card-api";
import { CardError } from "./card-contracts";
import { getConfig } from "./config";
import { getDb } from "./db";
import { GradingService } from "./grading";
import { ReviewError, reviewCommandSchema } from "./review-contracts";
import {
  endReview,
  finalizeReview,
  getToday,
  revealAnswer,
  startReview,
} from "./reviews";

const services = globalThis as typeof globalThis & {
  webcardsGrading?: GradingService;
};
const grading = (services.webcardsGrading ??= new GradingService());
function reply(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}
export async function handleReviewRequest(request: Request) {
  try {
    const config = getConfig();
    if (
      request.method !== "GET" &&
      request.headers.get("origin") !== new URL(config.BETTER_AUTH_URL).origin
    )
      throw new ReviewError(403, "origin", "Untrusted origin.");
    const session = await ownerSession(request.headers);
    if (!session)
      throw new ReviewError(
        401,
        "unauthorized",
        "Please sign in again to review your vocabulary.",
      );
    const owner = session.user.id,
      db = getDb();
    if (request.method === "GET") return reply(await getToday(db, owner));
    if (request.method !== "POST")
      return reply({ error: "Method not allowed." }, 405);
    const command = reviewCommandSchema.parse(await readJson(request));
    if (command.action === "start") return reply(await startReview(db, owner));
    if (command.action === "end") await endReview(db, owner, command.sessionId);
    if (command.action === "reveal")
      await revealAnswer(db, owner, command.itemId);
    if (command.action === "finalize")
      await finalizeReview(db, owner, command.itemId, command.decision);
    if (command.action === "check")
      await grading.check(
        db,
        owner,
        command.itemId,
        command.answer,
        {
          baseURL: config.MODEL_BASE_URL,
          apiKey: config.MODEL_API_KEY,
          model: config.MODEL_NAME,
        },
        config.GRADINGS_PER_DAY,
      );
    return reply(await getToday(db, owner));
  } catch (error) {
    if (error instanceof ReviewError || error instanceof CardError)
      return reply({ error: error.message, code: error.code }, error.status);
    if (error instanceof z.ZodError)
      return reply(
        { error: "Check your answer and try again.", code: "validation" },
        400,
      );
    console.error(
      JSON.stringify({ event: "review_error", category: "internal" }),
    );
    return reply(
      {
        error:
          "Review is temporarily unavailable. Retry to check whether your action was saved.",
      },
      503,
    );
  }
}
