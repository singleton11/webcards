import { describe, expect, it } from "vitest";
import { State } from "ts-fsrs";
import {
  automaticRating,
  emptySchedule,
  exactAnswer,
  localDay,
  reviewSides,
  scheduleReview,
} from "../src/lib/scheduler";
import { gradeSchema, reviewCommandSchema } from "../src/lib/review-contracts";

const content = {
  russian: "берег",
  english: "bank",
  sense: "river edge",
  context: "river",
  note: "",
};
const now = new Date("2026-11-13T12:00:00Z");
describe("review policy", () => {
  it("selects the stored prompt/reference independently in both directions", () => {
    expect(reviewSides(content, "ru-en")).toMatchObject({
      prompt: "берег",
      reference: "bank",
      source: "ru",
      target: "en",
    });
    expect(reviewSides(content, "en-ru")).toMatchObject({
      prompt: "bank",
      reference: "берег",
      source: "en",
      target: "ru",
    });
  });
  it("normalizes NFC and whitespace but does not invent language equivalences", () => {
    expect(exactAnswer("  river\n bank ", "river bank")).toBe(true);
    expect(exactAnswer("бере\u0301г", "бере́г")).toBe(true);
    for (const [a, b] of [
      ["Bank", "bank"],
      ["берег", "берёг"],
      ["don't", "do not"],
      ["no", "not"],
      ["hello!", "hello"],
      ["cafe", "café"],
    ])
      expect(exactAnswer(a, b)).toBe(false);
  });
  it("abstains on typo/needs-review and only maps verified failures to Again", () => {
    const grade = {
      verdict: "correct",
      reason: "ok",
      correction: null,
      source: "model",
    } as const;
    expect(automaticRating(grade)).toBe("good");
    expect(automaticRating({ ...grade, verdict: "incorrect" })).toBe("again");
    expect(automaticRating({ ...grade, verdict: "partial" })).toBe("again");
    expect(automaticRating({ ...grade, verdict: "typo" })).toBe(null);
    expect(automaticRating({ ...grade, verdict: "needs_review" })).toBe(null);
  });
  it("uses a one-minute Again step and independent serializable FSRS states", () => {
    const original = emptySchedule(now);
    const failed = scheduleReview(original, "again", now);
    const passed = scheduleReview(
      JSON.parse(JSON.stringify(original)),
      "good",
      now,
    );
    expect(original.reps).toBe(0);
    expect(failed.card.due.getTime() - now.getTime()).toBe(60000);
    expect(failed.card.reps).toBe(1);
    expect(passed.card.due.getTime()).toBeGreaterThan(
      failed.card.due.getTime(),
    );
  });
  it("repeated successful recall increases stability; a failure enters short relearning", () => {
    let card = emptySchedule(now);
    for (let i = 0; i < 6; i++)
      card = scheduleReview(card, "good", card.due).card;
    expect(card.state).toBe(State.Review);
    const success = scheduleReview(card, "good", card.due).card;
    const failure = scheduleReview(card, "again", card.due).card;
    expect(success.stability).toBeGreaterThan(card.stability);
    expect(failure.stability).toBeLessThan(card.stability);
    expect(failure.state).toBe(State.Relearning);
    expect(failure.due.getTime()).toBeLessThan(success.due.getTime());
  });
  it("uses IANA local days across midnight, DST and travel without changing UTC instants", () => {
    expect(localDay(new Date("2026-11-13T23:30:00Z"), "Europe/Amsterdam")).toBe(
      "2026-11-14",
    );
    expect(localDay(new Date("2026-11-13T23:30:00Z"), "America/New_York")).toBe(
      "2026-11-13",
    );
    for (const instant of ["2026-03-29T00:30:00Z", "2026-03-29T01:30:00Z"])
      expect(localDay(new Date(instant), "Europe/Amsterdam")).toBe(
        "2026-03-29",
      );
    for (const instant of ["2026-10-25T00:30:00Z", "2026-10-25T01:30:00Z"])
      expect(localDay(new Date(instant), "Europe/Amsterdam")).toBe(
        "2026-10-25",
      );
  });
  it("rejects browser-supplied references, grades and scheduling instructions", () => {
    expect(
      reviewCommandSchema.safeParse({
        action: "check",
        itemId: crypto.randomUUID(),
        answer: "bank",
        reference: "wrong",
      }).success,
    ).toBe(false);
    expect(
      gradeSchema.safeParse({
        verdict: "correct",
        reason: "ok",
        correction: null,
        dueAt: "tomorrow",
      }).success,
    ).toBe(false);
    expect(
      gradeSchema.safeParse({
        verdict: "probably",
        reason: "ok",
        correction: null,
      }).success,
    ).toBe(false);
    expect(
      reviewCommandSchema.safeParse({
        action: "check",
        itemId: crypto.randomUUID(),
        answer: "x".repeat(1001),
      }).success,
    ).toBe(false);
  });
});
