# Phase 3 validation and release boundaries

This is the historical Phase 3 record. The quiz policy was subsequently changed; see [Quiz policy validation](quiz-policy-validation.md) for current behavior and evidence.

## Scope

Phase 3 adds the daily review loop to the existing single-owner translator and saved-card library. The local Today screen starts one resumable session at a time; per-direction schedules and attempts live in PostgreSQL; answer checking is separate from review finalization. No production hosting, live model request, deployment, reminder, installable PWA, or public access is part of this phase.

The schedule is pinned to `ts-fsrs@5.2.0`, FSRS-6, 90% request retention, one-minute and ten-minute initial learning steps, a one-minute relearning step, and disabled interval fuzz. The application stores the algorithm/version and exact parameter snapshot with each finalized review. Each (card, direction) has independent state. Due learning/relearning cards and overdue reviews precede new cards. A frozen session chooses at most one due direction for each card, limits newly introduced cards to five per owner's local day, and leaves the other direction in the due backlog. The daily goal counts distinct card IDs in the owner's IANA timezone; repeated attempts do not inflate it.

Only NFC and whitespace are normalized for a deterministic answer shortcut. Non-exact answers are checked against the server-stored card sense, context, direction and reference. The browser cannot provide a reference answer, verdict, FSRS state, or due date. A pinned, strict Responses JSON contract accepts `correct`, `typo`, `partial`, `incorrect`, or `needs_review`; uncertainty/typos require self-assessment. Finalization is one transaction: durable attempt result, review event and the matching directional schedule are committed together. Replays return the result; stale edits/schedules fail without double-applying or advancing the other direction. Content edits preserve the prior versions/events and invalidate affected pending questions. Explicit Reset learning resets both directions and retains history.

One exact match causes no model request. A non-exact grade reserves up to two calls against `GRADINGS_PER_DAY` (default 100 reserved requests per UTC day), allows one bounded retry and a 20-second deadline, and is subject to a two-request process-local concurrency limit. The typed answer, saved meaning, and context are submitted to the configured LiteLLM endpoint. No raw answers are written to application event logs. Provider/upstream identity, retention, subscription terms, cost, quality, and production reliability remain unverified.

## Automated checks

- `npm run typecheck` passes.
- `npm test` passes 84 unit/integration tests against disposable PostgreSQL and mocked model responses. Coverage includes schedule independence, repeated Again/Good behavior, DST/local-day conversion, exact-match boundaries, untrusted response schemas, migration from Phase 2 data, per-direction finalization, immutable replay, concurrent tabs, frozen queues, new-card/backlog priority, goal counts, stale content/schedule conflicts, owner isolation, archive/delete cleanup, explicit reset, grading budgets, model outages, preserved answers, and uncertainty/self-assessment.
- `npm run test:browser` passes 19 Chromium scenarios at 390px and 1365px. New scenarios cover translate/save/review in both directions, relearning wait and resume, uncertainty/self-assessment, stale edits, a lost finalization response, and grading outage/reveal. They use a disposable PostgreSQL cluster and a fake local LiteLLM endpoint, never the configured real service.
- `npm run build` passes and produces `/api/reviews` and `/today` as dynamic routes. No live inference was made.
- Before/after process, port, and temporary-directory checks found no PostgreSQL test process, `33117` listener, or new `/tmp/webcards-browser-pg-*` directory after validation. Pre-existing external test processes were not stopped or cleaned up.

## Remaining boundaries

- No independent held-out Russian/English grading or translation benchmark was run. The fake grading endpoint verifies request shape, failure handling, and UI wiring only; it establishes no real-model quality or calibration.
- LiteLLM alias liveness and the earlier two-phrase transport smoke check do not establish upstream identity, subscription eligibility/limits, privacy/retention, latency, grading accuracy, or costs. Review/translation provider terms require verification before entering sensitive text or personal release.
- Timezone and goal use the existing PostgreSQL preference row (defaults to UTC and 12); a settings UI to edit them is deferred. Account-wide export/deletion, tested backup/restore, retention controls, browser offline storage, notifications, and deployment are also outside this phase.
- The two-request limiter and grading replay coordination are process-local; the current single local process is not configured or validated for horizontally scaled production use.
- Schedule reset for an edited meaning is explicit rather than automatic, preventing silent learning loss. Archived cards retain their schedules and resume the old due state if restored.

## Starting an existing installation

Back up the local database according to the operator's existing procedure, then run `npm run db:migrate` before starting the updated app. Versioned migrations preserve card content, credentials, and preferences. There is no live database or persistent service change as part of this validation.
