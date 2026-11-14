import { describe, expect, it } from "vitest";
import {
  modelResultSchema,
  translationInputSchema,
} from "../src/lib/contracts";
const input = {
  requestId: crypto.randomUUID(),
  source: "ru",
  target: "en",
  text: " слово ",
};
describe("translation contracts", () => {
  it("trims input without silently switching direction", () => {
    expect(translationInputSchema.parse(input)).toMatchObject({
      text: "слово",
      source: "ru",
      target: "en",
      context: "",
    });
  });
  it.each([
    { ...input, text: " " },
    { ...input, text: "x".repeat(501) },
    { ...input, target: "ru" },
    { ...input, source: "de" },
    { ...input, requestId: "bad" },
    { ...input, context: "x".repeat(301) },
    { ...input, model: "another" },
  ])("rejects invalid input %#", (value) => {
    expect(translationInputSchema.safeParse(value).success).toBe(false);
  });
  it("requires one clear alternative for an ok result", () => {
    expect(
      modelResultSchema.safeParse({
        status: "ok",
        alternatives: [],
        clarification: null,
      }).success,
    ).toBe(false);
  });
  it("requires a real clarification without guessed alternatives", () => {
    expect(
      modelResultSchema.safeParse({
        status: "needs_context",
        alternatives: [],
        clarification: "Which sense?",
      }).success,
    ).toBe(true);
    expect(
      modelResultSchema.safeParse({
        status: "needs_context",
        alternatives: [],
        clarification: " ",
      }).success,
    ).toBe(false);
  });
});
