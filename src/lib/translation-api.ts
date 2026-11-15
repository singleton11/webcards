import { ownerSession } from "./auth";
import { getConfig } from "./config";
import { translationInputSchema, TranslationError } from "./contracts";
import { getDb } from "./db";
import { translate } from "./model";
import { reserveTranslation } from "./persistence";
import { TranslationService } from "./translation-service";
const service = new TranslationService({
  reserve: (owner) =>
    reserveTranslation(getDb(), owner, getConfig().TRANSLATIONS_PER_DAY),
  run: async (input) => {
    const config = getConfig();
    const { result, usage } = await translate(input, {
      baseURL: config.LITELLM_BASE_URL,
      apiKey: config.LITELLM_API_KEY,
      model: config.LITELLM_MODEL,
    });
    console.info(
      JSON.stringify({
        event: "translation",
        model: config.LITELLM_MODEL,
        promptVersion: result.promptVersion,
        ...usage,
      }),
    );
    return result;
  },
});
function reply(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
export async function handleTranslationRequest(request: Request) {
  try {
    const config = getConfig();
    if (
      request.headers.get("origin") !== new URL(config.BETTER_AUTH_URL).origin
    )
      return reply({ error: "Untrusted origin." }, 403);
    const session = await ownerSession(request.headers);
    if (!session)
      return reply(
        { error: "Please sign in again. Your text has not been sent." },
        401,
      );
    if (!request.headers.get("content-type")?.startsWith("application/json"))
      return reply({ error: "Expected JSON." }, 415);
    const reader = request.body?.getReader();
    if (!reader) return reply({ error: "Enter some text." }, 400);
    let bytes = 0,
      body = "";
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 8192) {
        await reader.cancel();
        return reply({ error: "Request is too large." }, 413);
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      return reply({ error: "Invalid JSON." }, 400);
    }
    const parsed = translationInputSchema.safeParse(json);
    if (!parsed.success)
      return reply(
        {
          error:
            "Use Russian and English, up to 500 characters, with optional context up to 300 characters.",
        },
        400,
      );
    if (!config.LITELLM_API_KEY)
      return reply(
        {
          error:
            "Translation is not connected yet. Your text has not been sent.",
        },
        503,
      );
    return reply(await service.submit(session.user.id, parsed.data));
  } catch (error) {
    if (error instanceof TranslationError)
      return reply({ error: error.message, code: error.code }, error.status);
    console.error(
      JSON.stringify({ event: "translation_error", category: "internal" }),
    );
    return reply(
      {
        error:
          "The service is unavailable. Your text has not been saved; try again later.",
      },
      503,
    );
  }
}
