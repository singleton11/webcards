import { describe, expect, it, vi } from "vitest";
import { TranslationService } from "../src/lib/translation-service";
import type { TranslationResult } from "../src/lib/contracts";
const input = {
  requestId: crypto.randomUUID(),
  source: "en" as const,
  target: "ru" as const,
  text: "hello",
  context: "",
};
const result: TranslationResult = {
  status: "ok",
  alternatives: [{ translation: "привет", sense: "greeting", note: "" }],
  clarification: null,
  source: "en",
  target: "ru",
  model: "test",
  promptVersion: "test",
};
describe("translation admission", () => {
  it("joins concurrent identical retries and replays briefly", async () => {
    const run = vi.fn(async () => result),
      reserve = vi.fn(async () => true);
    const service = new TranslationService({ run, reserve });
    expect(
      await Promise.all([
        service.submit("owner", input),
        service.submit("owner", input),
      ]),
    ).toEqual([result, result]);
    await service.submit("owner", input);
    expect(run).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledTimes(1);
  });
  it("rejects request identity reuse with changed text", async () => {
    const service = new TranslationService({
      run: async () => result,
      reserve: async () => true,
    });
    await service.submit("owner", input);
    await expect(
      service.submit("owner", { ...input, text: "different" }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("scopes replay to the owner", async () => {
    const run = vi.fn(async () => result);
    const service = new TranslationService({ run, reserve: async () => true });
    await service.submit("a", input);
    await service.submit("b", input);
    expect(run).toHaveBeenCalledTimes(2);
  });
  it("rejects over-quota without inference", async () => {
    const run = vi.fn();
    const service = new TranslationService({ run, reserve: async () => false });
    await expect(service.submit("a", input)).rejects.toMatchObject({
      code: "daily_limit",
    });
    expect(run).not.toHaveBeenCalled();
  });
  it("caps concurrency and releases failed requests", async () => {
    let finish!: (value: TranslationResult) => void;
    const waiting = new Promise<TranslationResult>((resolve) => {
      finish = resolve;
    });
    const service = new TranslationService({
      run: async () => waiting,
      reserve: async () => true,
    });
    const one = service.submit("a", input),
      two = service.submit("b", input);
    await expect(service.submit("c", input)).rejects.toMatchObject({
      code: "busy",
    });
    finish(result);
    await Promise.all([one, two]);
    expect(await service.submit("c", input)).toEqual(result);
  });
});
