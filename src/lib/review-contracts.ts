import { z } from "zod";
import { normalizeCardText } from "./card-contracts";

export const directionSchema = z.enum(["ru-en", "en-ru"]);
export type Direction = z.infer<typeof directionSchema>;
export const gradeSchema = z
  .object({
    verdict: z.enum([
      "correct",
      "typo",
      "partial",
      "incorrect",
      "needs_review",
    ]),
    reason: z.string().trim().min(1).max(400),
    correction: z.string().trim().max(1000).nullable(),
  })
  .strict();
export type Grade = z.infer<typeof gradeSchema> & {
  source: "exact" | "model" | "reveal";
  model?: string;
  promptVersion?: string;
};
export const reviewCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start") }).strict(),
  z.object({ action: z.literal("end"), sessionId: z.uuid() }).strict(),
  z
    .object({
      action: z.literal("check"),
      itemId: z.uuid(),
      answer: z
        .string()
        .transform(normalizeCardText)
        .pipe(
          z
            .string()
            .min(1)
            .max(1000)
            .refine((s) => !s.includes("\0")),
        ),
    })
    .strict(),
  z.object({ action: z.literal("reveal"), itemId: z.uuid() }).strict(),
  z
    .object({
      action: z.literal("finalize"),
      itemId: z.uuid(),
      decision: z.enum(["accept", "good", "again", "skip"]),
    })
    .strict(),
]);
export type ReviewCommand = z.infer<typeof reviewCommandSchema>;
export type ReviewItem = {
  id: string;
  cardId: string;
  direction: Direction;
  prompt: string;
  sense: string;
  context: string;
  answer: string | null;
  reference: string | null;
  grade: Grade | null;
  availableAt: string;
};
export type ReviewSession = {
  id: string;
  remaining: number;
  item: ReviewItem | null;
};
export type Today = {
  timezone: string;
  day: string;
  completed: number;
  attempts: number;
  dueCards: number;
  dueDirections: number;
  totalCards: number;
  session: ReviewSession | null;
};
export class ReviewError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
