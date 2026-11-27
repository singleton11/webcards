import { z } from "zod";

// Keep case, punctuation and accents: these can distinguish legitimate meanings.
export function normalizeCardText(value: string) {
  return value.normalize("NFC").trim().replace(/\s+/gu, " ");
}
function text(max: number, required = false) {
  return z
    .string()
    .transform(normalizeCardText)
    .pipe(
      z
        .string()
        .min(required ? 1 : 0)
        .max(max)
        .refine((s) => !s.includes("\0")),
    );
}
export const cardContentSchema = z
  .object({
    russian: text(1000, true),
    english: text(1000, true),
    sense: text(160, true),
    context: text(300),
    note: text(300),
  })
  .strict();
export type CardContent = z.infer<typeof cardContentSchema>;
export const saveCardSchema = z
  .object({
    requestId: z.uuid(),
    content: cardContentSchema,
    source: z.enum(["ru", "en"]),
    model: z.enum(["gpt-6-luna", "chatgpt-gpt-6-luna"]),
    promptVersion: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-zA-Z0-9._-]+$/),
  })
  .strict();
export type SaveCardInput = z.infer<typeof saveCardSchema>;
const commandBase = {
  requestId: z.uuid(),
  revision: z.number().int().positive(),
};
export const cardCommandSchema = z.discriminatedUnion("action", [
  z
    .object({
      ...commandBase,
      action: z.literal("edit"),
      content: cardContentSchema,
    })
    .strict(),
  z.object({ ...commandBase, action: z.literal("archive") }).strict(),
  z.object({ ...commandBase, action: z.literal("restore") }).strict(),
  z.object({ ...commandBase, action: z.literal("delete") }).strict(),
  z.object({ ...commandBase, action: z.literal("reset") }).strict(),
  z
    .object({
      ...commandBase,
      action: z.literal("undo"),
      saveRequestId: z.uuid(),
    })
    .strict(),
]);
export type CardCommand = z.infer<typeof cardCommandSchema>;
export const cardQuerySchema = z
  .object({
    q: text(100).default(""),
    status: z.enum(["active", "archived"]).default("active"),
    page: z.coerce.number().int().min(1).max(100000).default(1),
  })
  .strict();
export type CardQuery = z.infer<typeof cardQuerySchema>;
export type Card = {
  id: string;
  status: "active" | "archived";
  revision: number;
  version: number;
  content: CardContent;
  source: "ru" | "en";
  model: string;
  promptVersion: string;
  createdAt: string;
  updatedAt: string;
  reviewStats: {
    correct: number;
    attempts: number;
    nextReviewAt: string | null;
  };
};
export type CardOutcome =
  | "created"
  | "duplicate"
  | "updated"
  | "unchanged"
  | "archived"
  | "restored"
  | "deleted"
  | "reset"
  | "undone";
export type CardResult = {
  card: Card | null;
  cardId: string;
  outcome: CardOutcome;
  revision: number;
};
export type CardList = {
  cards: Card[];
  total: number;
  page: number;
  pageSize: number;
};
export class CardError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
