"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { ReviewCommand, Today } from "@/lib/review-contracts";

async function request(command?: ReviewCommand): Promise<Today> {
  const response = await fetch(
    "/api/reviews",
    command
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(command),
        }
      : { cache: "no-store" },
  );
  const body = await response.json();
  if (!response.ok)
    throw new Error(body.error || "Review is unavailable. Please retry.");
  return body;
}
export function DailyReview() {
  const [today, setToday] = useState<Today | null>(null);
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setToday(await request());
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load Today.");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const current = today?.session?.item;
  useEffect(() => {
    setAnswer(current?.answer ?? "");
  }, [current?.id, current?.answer]);
  async function act(command: ReviewCommand) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      setToday(await request(command));
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Connection interrupted. Retry the same action; no answer has been discarded.",
      );
    } finally {
      setBusy(false);
    }
  }
  const defaultAction =
    current?.grade?.verdict === "correct" ||
    current?.grade?.verdict === "incorrect" ||
    current?.grade?.verdict === "partial";
  return (
    <main className="review-page">
      <section className="intro review-intro">
        <div>
          <span className="eyebrow">A LITTLE, EVERY DAY</span>
          <h1>
            Make it
            <br />
            <em>second nature.</em>
          </h1>
        </div>
        <p>
          One meaning at a time.
          <br />
          Recall it today, meet it again when it is due.
        </p>
      </section>
      {error && (
        <div className="error-banner" role="alert">
          {error}{" "}
          <button
            className="text-button"
            onClick={() => void load()}
            disabled={busy}
          >
            Refresh Today
          </button>
        </div>
      )}
      {!today ? (
        <p role="status">
          {error ? "Today could not be loaded." : "Loading your review..."}
        </p>
      ) : (
        <>
          <section className="review-stats" aria-label="Today's progress">
            <div>
              <span>Today</span>
              <strong>{today.completed}</strong>
              <p>distinct cards reviewed</p>
            </div>
            <div>
              <span>Waiting</span>
              <strong>{today.dueCards}</strong>
              <p>due cards / {today.dueDirections} directions</p>
            </div>
            <div>
              <span>Your pace</span>
              <strong>No limit</strong>
              <p>one appearance per card each day</p>
            </div>
          </section>
          <p className="review-caption">
            Day: {today.day} ({today.timezone}) - {today.attempts}{" "}
            {today.attempts === 1 ? "answer" : "answers"}. Answered cards rest
            in both directions until at least tomorrow.
          </p>
          {!current ? (
            <section className="review-empty">
              <span className="eyebrow">YOUR NEXT CHAPTER</span>
              <h2>
                {today.dueCards
                  ? "Ready when you are."
                  : "You're all caught up."}
              </h2>
              <p>
                {today.dueCards
                  ? "Keep going through all available cards, one at a time. No daily limit."
                  : "Missed cards return tomorrow. Correct answers return when spaced repetition makes them due."}
              </p>
              {today.dueCards > 0 && (
                <button
                  className="primary-button"
                  disabled={busy}
                  onClick={() => void act({ action: "start" })}
                >
                  Start review
                </button>
              )}{" "}
              <Link className="secondary-button review-link" href="/">
                Translate something
              </Link>
            </section>
          ) : (
            <section className="review-sheet" aria-label="Review question">
              <div className="review-topline">
                <span className="eyebrow">
                  {current.direction === "ru-en"
                    ? "RUSSIAN TO ENGLISH"
                    : "ENGLISH TO RUSSIAN"}
                </span>
                <span>{today.session?.remaining} cards left</span>
              </div>
              <h2 lang={current.direction === "ru-en" ? "ru" : "en"}>
                {current.prompt}
              </h2>
              <div className="review-context">
                <span>Meaning</span>
                <p>{current.sense}</p>
                {current.context && (
                  <>
                    <span>Context</span>
                    <p>{current.context}</p>
                  </>
                )}
              </div>
              {!current.grade && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act({
                      action: "check",
                      itemId: current.id,
                      answer,
                    });
                  }}
                >
                  <label htmlFor="review-answer">Your translation</label>
                  <textarea
                    id="review-answer"
                    lang={current.direction === "ru-en" ? "en" : "ru"}
                    maxLength={1000}
                    value={answer}
                    disabled={busy}
                    required
                    onChange={(e) => setAnswer(e.target.value)}
                  />
                  <div className="review-actions">
                    <button
                      className="primary-button"
                      disabled={busy || !answer.trim()}
                    >
                      {busy ? "Checking..." : "Check answer"}
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busy}
                      onClick={() =>
                        void act({ action: "reveal", itemId: current.id })
                      }
                    >
                      Show answer
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      disabled={busy}
                      onClick={() =>
                        void act({
                          action: "finalize",
                          itemId: current.id,
                          decision: "skip",
                        })
                      }
                    >
                      Skip without rating
                    </button>
                  </div>
                  <p className="review-privacy">
                    Non-exact answers and this card's context are sent to the
                    configured LiteLLM provider for checking. Provider retention
                    remains unverified.
                  </p>
                </form>
              )}
              {current.grade && (
                <div className="review-feedback" aria-live="polite">
                  <span className="eyebrow">
                    {current.grade.source === "reveal"
                      ? "ANSWER REVEALED"
                      : current.grade.verdict.replace("_", " ").toUpperCase()}
                  </span>
                  <h3>Saved answer</h3>
                  <p
                    className="review-reference"
                    lang={current.direction === "ru-en" ? "en" : "ru"}
                  >
                    {current.reference}
                  </p>
                  {current.answer && (
                    <p>
                      Your answer: <strong>{current.answer}</strong>
                    </p>
                  )}
                  <p>{current.grade.reason}</p>
                  {current.grade.correction && (
                    <p>Suggested correction: {current.grade.correction}</p>
                  )}
                  {(current.grade.verdict === "typo" ||
                    current.grade.verdict === "needs_review") && (
                    <p>
                      This needs your judgment; it will not update the schedule
                      automatically.
                    </p>
                  )}
                  <div className="review-actions">
                    {defaultAction && (
                      <button
                        className="primary-button"
                        disabled={busy}
                        onClick={() =>
                          void act({
                            action: "finalize",
                            itemId: current.id,
                            decision: "accept",
                          })
                        }
                      >
                        Continue with result
                      </button>
                    )}
                    <button
                      className="secondary-button"
                      disabled={busy}
                      onClick={() =>
                        void act({
                          action: "finalize",
                          itemId: current.id,
                          decision: "good",
                        })
                      }
                    >
                      I recalled it
                    </button>
                    <button
                      className="secondary-button"
                      disabled={busy}
                      onClick={() =>
                        void act({
                          action: "finalize",
                          itemId: current.id,
                          decision: "again",
                        })
                      }
                    >
                      Review tomorrow
                    </button>
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() =>
                        void act({
                          action: "finalize",
                          itemId: current.id,
                          decision: "skip",
                        })
                      }
                    >
                      Skip without rating
                    </button>
                  </div>
                </div>
              )}
              <button
                className="text-button review-end"
                disabled={busy}
                onClick={() =>
                  void act({ action: "end", sessionId: today.session!.id })
                }
              >
                End session without rating remaining questions
              </button>
            </section>
          )}
        </>
      )}
    </main>
  );
}
