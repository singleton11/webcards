import { z } from "zod";
const configSchema = z.object({
  DATABASE_URL: z
    .url()
    .refine(
      (s) => s.startsWith("postgresql://") || s.startsWith("postgres://"),
    ),
  BETTER_AUTH_URL: z.url(),
  BETTER_AUTH_SECRET: z
    .string()
    .min(32)
    .refine((value) => !value.startsWith("replace-")),
  OWNER_USERNAME: z.string().regex(/^[a-z0-9_]{3,30}$/),
  MODEL_BASE_URL: z.url().default("http://127.0.0.1:18317/v1"),
  MODEL_API_KEY: z.string().default(""),
  MODEL_NAME: z.literal("gpt-6-luna").default("gpt-6-luna"),
  TRANSLATIONS_PER_DAY: z.coerce.number().int().min(1).max(1000).default(100),
  GRADINGS_PER_DAY: z.coerce.number().int().min(2).max(1000).default(100),
});
export function getConfig() {
  const result = configSchema.safeParse(process.env);
  if (!result.success)
    throw new Error("Webcards configuration is incomplete. See .env.example.");
  const origin = new URL(result.data.BETTER_AUTH_URL);
  if (
    origin.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
  ) {
    throw new Error("Non-local access requires HTTPS.");
  }
  return result.data;
}
