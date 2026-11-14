import { z } from "zod";
import {
  modelResultSchema,
  TranslationError,
  type TranslationInput,
  type TranslationResult,
} from "./contracts";
import { PROMPT_VERSION, TRANSLATION_PROMPT } from "./translation-prompt";
export type ModelConfig = {
  baseURL: string;
  apiKey: string;
  model: string;
  deadlineMs?: number;
};
export type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  calls: number;
  latencyMs: number;
};
const MAX_RESPONSE_BYTES = 128_000;
export async function boundedText(response: Response) {
  if (!response.body) throw new Error("Empty model response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "",
    size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_RESPONSE_BYTES)
        throw new Error("Oversized model response");
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }
}
export function parseResponse(
  body: string,
  eventStream: boolean,
): { text: string; inputTokens: number; outputTokens: number } {
  let response: Record<string, unknown>;
  if (eventStream) {
    const events = body.replaceAll("\r\n", "\n").split("\n\n");
    let completed: Record<string, unknown> | undefined;
    for (const event of events) {
      const data = event
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data || data === "[DONE]") continue;
      const parsed = JSON.parse(data);
      if (
        ["response.failed", "response.incomplete", "error"].includes(
          parsed.type,
        )
      )
        throw new Error("Model did not complete");
      if (parsed.type === "response.completed") completed = parsed.response;
    }
    if (!completed) throw new Error("Missing model completion");
    response = completed;
  } else response = JSON.parse(body);
  if (response.status !== "completed")
    throw new Error("Model did not complete");
  const output = z
    .array(
      z.object({
        type: z.string(),
        content: z
          .array(z.object({ type: z.string(), text: z.string().optional() }))
          .optional(),
      }),
    )
    .parse(response.output);
  const text = output
    .filter((o) => o.type === "message")
    .flatMap((o) => o.content ?? [])
    .filter((o) => o.type === "output_text")
    .map((o) => o.text ?? "")
    .join("");
  const usage = z
    .object({
      input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative(),
    })
    .parse(response.usage);
  return {
    text,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
  };
}
export async function translate(
  input: TranslationInput,
  config: ModelConfig,
  fetcher: typeof fetch = fetch,
): Promise<{ result: TranslationResult; usage: ModelUsage }> {
  if (!config.apiKey)
    throw new TranslationError(
      "model_not_configured",
      503,
      "Translation is not connected yet. Your text has not been sent.",
    );
  const started = Date.now();
  const signal = AbortSignal.timeout(config.deadlineMs ?? 20_000);
  let calls = 0,
    inputTokens = 0,
    outputTokens = 0;
  const schema = z.toJSONSchema(modelResultSchema);
  delete schema.$schema;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      calls++;
      const response = await fetcher(
        config.baseURL.replace(/\/$/, "") + "/responses",
        {
          method: "POST",
          signal,
          redirect: "error",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + config.apiKey,
          },
          body: JSON.stringify({
            model: config.model,
            stream: true,
            store: false,
            max_output_tokens: 1200,
            input: [
              { role: "system", content: TRANSLATION_PROMPT },
              {
                role: "user",
                content: JSON.stringify({
                  source: input.source,
                  target: input.target,
                  text: input.text,
                  context: input.context,
                }),
              },
            ],
            text: {
              format: {
                type: "json_schema",
                name: "translation",
                strict: true,
                schema,
              },
            },
          }),
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        if ([429, 502, 503, 504].includes(response.status) && attempt === 0)
          continue;
        throw new TranslationError(
          "model_unavailable",
          502,
          "The translation service is unavailable. Your text is still here; try again later.",
        );
      }
      const parsed = parseResponse(
        await boundedText(response),
        response.headers.get("content-type")?.includes("text/event-stream") ??
          false,
      );
      inputTokens += parsed.inputTokens;
      outputTokens += parsed.outputTokens;
      const result = modelResultSchema.parse(JSON.parse(parsed.text));
      return {
        result: {
          ...result,
          source: input.source,
          target: input.target,
          model: config.model,
          promptVersion: PROMPT_VERSION,
        },
        usage: {
          calls,
          inputTokens,
          outputTokens,
          latencyMs: Date.now() - started,
        },
      };
    } catch (error) {
      if (signal.aborted)
        throw new TranslationError(
          "model_timeout",
          504,
          "Translation took too long. Your text is still here; you can retry.",
        );
      if (error instanceof TranslationError) throw error;
      if (attempt === 1)
        throw new TranslationError(
          "invalid_model_response",
          502,
          "No reliable translation was returned. Your text has not been saved.",
        );
    }
  }
  throw new TranslationError(
    "model_unavailable",
    502,
    "Translation is unavailable.",
  );
}
