import {
  createEmptyCard,
  fsrs,
  generatorParameters,
  Rating,
  type Card,
  type CardInput,
} from "ts-fsrs";
import type { Direction, Grade } from "./review-contracts";
import { normalizeCardText, type CardContent } from "./card-contracts";

export const SCHEDULER_VERSION = "ts-fsrs-5.2.0/fsrs-6/webcards-v2";
export const SCHEDULER_PARAMETERS = generatorParameters({
  request_retention: 0.9,
  enable_fuzz: false,
  enable_short_term: false,
  learning_steps: [],
  relearning_steps: [],
});
const scheduler = fsrs(SCHEDULER_PARAMETERS);
export function emptySchedule(now: Date): Card {
  return createEmptyCard(now);
}
export function scheduleReview(
  before: CardInput,
  rating: "good" | "again",
  now: Date,
) {
  return scheduler.next(
    before,
    now,
    rating === "good" ? Rating.Good : Rating.Again,
  );
}
export function reviewSides(content: CardContent, direction: Direction) {
  return direction === "ru-en"
    ? {
        prompt: content.russian,
        reference: content.english,
        source: "ru",
        target: "en",
      }
    : {
        prompt: content.english,
        reference: content.russian,
        source: "en",
        target: "ru",
      };
}
// Case, punctuation, ё/е and accents can alter meaning. Only NFC/whitespace are safe shortcuts.
export function exactAnswer(answer: string, reference: string) {
  return normalizeCardText(answer) === normalizeCardText(reference);
}
export function automaticRating(grade: Grade): "good" | "again" | null {
  if (grade.verdict === "correct") return "good";
  if (grade.verdict === "incorrect" || grade.verdict === "partial")
    return "again";
  return null;
}
export function localDay(now: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (name: string) => parts.find((p) => p.type === name)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
