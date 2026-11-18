import { getConfig } from "../src/lib/config";
import { translate } from "../src/lib/model";
const config = getConfig();
for (const input of [
  {
    source: "ru" as const,
    target: "en" as const,
    text: "Доброе утро",
    context: "A greeting",
  },
  {
    source: "en" as const,
    target: "ru" as const,
    text: "Thank you",
    context: "A polite expression of gratitude",
  },
]) {
  const { result, usage } = await translate(
    { ...input, requestId: crypto.randomUUID() },
    {
      baseURL: config.MODEL_BASE_URL,
      apiKey: config.MODEL_API_KEY,
      model: config.MODEL_NAME,
    },
  );
  console.log(
    JSON.stringify({
      direction: input.source + "->" + input.target,
      result,
      usage,
    }),
  );
}
