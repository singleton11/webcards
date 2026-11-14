# Unlimited daily quiz policy

## Behavior

- A quiz contains all currently eligible active cards. There is no daily-goal stopping point, five-new-card cap, session-size cap, or 200-row candidate scan limit.
- Each vocabulary card appears at most once per configured server calendar day (UTC in the deployed configuration), regardless of translation direction. Finalization, not merely submitting an answer for checking, retires the card for that day.
- An incorrect result, reveal accepted as incorrect, or explicit **Review tomorrow** self-assessment trains the selected directional FSRS state with Again and sets its due instant to next local midnight. It does not append a same-day relearning question. The missed direction is prioritized over an untouched opposite direction the next day.
- A correct result or **I recalled it** self-assessment uses FSRS Good. Short-term learning/relearning is disabled, so successful reviews use day-scale intervals. The selected schedule is never due before tomorrow. Each direction retains its own schedule; an overdue opposite direction can become eligible on a later day.
- The queue is deterministic and resumable. Completing it shows a caught-up state; newly saved eligible cards can start another queue the same day. Unrated skips and ending a queue still leave scheduling untouched and do not count as completed answers.
- Uncertain grades, typos, inference failures, and timeouts still require an explicit resolved result or self-assessment; they do not silently penalize recall.

## Compatibility

No new schema migration, account change, or learning reset is required. Existing review history remains intact. The legacy daily-goal preference remains stored but is not returned or used by the quiz. The previous five-new-card allowance is removed from the Today contract and UI.

New events record policy `ts-fsrs-5.2.0/fsrs-6/webcards-v2` and its parameter snapshot: 90% desired retention, disabled fuzz, disabled short-term scheduling, and empty learning/relearning steps. Only the answered direction's FSRS state and revision change. Wrong-answer due-time overrides are stored consistently in the event's after-state, live directional schedule, and durable finalization receipt.

Same-day suppression applies both when selecting/counting eligible cards and when pruning/validating persisted queues, including old relearning items produced by the previous policy. Existing due times are not bulk-rewritten; the new scheduling policy applies when each future answer is finalized.

## Verification

Validation uses an isolated source/dependency copy without `.env.local`, disposable PostgreSQL, and a fake local LiteLLM server. The live `.next` build, service, production database, and model credentials are not used or changed.

- `npm run typecheck`: passes.
- `npm test`: 99 tests pass across 10 files.
- `npm run test:browser`: all 34 Chromium scenarios pass together against development mode, including 390px and 1365px review screens.
- `npm run build`: passes with Next.js 16.4.6/Turbopack.
- All 34 browser scenarios also pass against that production build when run one spec file per fresh disposable fixture. The eight review scenarios include both mobile and desktop, feedback resumption, more than 12 completed cards, both correct and incorrect answers, no same-day repetition, grading uncertainty/outage, stale content, and replay after a lost finalization response.
- Database regressions cover a 205-card queue, next-day wrong-direction retries, correct FSRS intervals, new cards added after a completed queue, old-policy pending repeats, midnight exclusion, DST transitions, directional state isolation, and finalization concurrency/idempotency.
- Review screenshots are visually checked for mobile layout; no horizontal overflow is detected by the browser assertions.

An initial combined production-browser run hit the normal five-sign-ins-per-minute shared bucket after 19 scenarios. Production intentionally ignores `WEBCARDS_E2E_FIXTURE`; its authentication limits are unchanged. Per-file fresh fixtures keep each suite independent and within that real limit, rather than weakening the application for testing.

These validation runs make no live model calls and do not deploy the change. Live activation is a separate, explicitly authorized operation. Browser PostgreSQL clusters and the port 33117 listener are stopped and cleaned up after the runs.
