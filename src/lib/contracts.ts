import { z } from "zod";
export const languageSchema = z.enum(["ru", "en"]);
export const translationInputSchema = z
  .object({
    requestId: z.uuid(),
    source: languageSchema,
    target: languageSchema,
    text: z.string().trim().min(1).max(500),
    context: z.string().trim().max(300).default(""),
  })
  .strict()
  .refine((v) => v.source !== v.target, {
    message: "Choose different source and target languages.",
  });
export type TranslationInput = z.infer<typeof translationInputSchema>;
export const modelResultSchema = z
  .object({
    status: z.enum(["ok", "needs_context"]),
    alternatives: z
      .array(
        z
          .object({
            translation: z.string().min(1).max(1000),
            sense: z.string().min(1).max(160),
            note: z.string().max(300),
          })
          .strict(),
      )
      .max(3),
    clarification: z.string().max(300).nullable(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      v.status === "ok" &&
      (v.alternatives.length === 0 || v.clarification !== null)
    )
      ctx.addIssue({
        code: "custom",
        message: "A result needs alternatives and no clarification.",
      });
    if (
      v.status === "needs_context" &&
      (v.alternatives.length !== 0 || !v.clarification?.trim())
    )
      ctx.addIssue({
        code: "custom",
        message:
          "An ambiguous result needs a question, not a guessed translation.",
      });
  });
export type ModelResult = z.infer<typeof modelResultSchema>;
export type TranslationResult = ModelResult & {
  source: "ru" | "en";
  target: "ru" | "en";
  model: string;
  promptVersion: string;
};
export class TranslationError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
