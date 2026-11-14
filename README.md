# Webcards

A private Russian/English translator with an opt-in personal vocabulary list, daily typed reviews with spaced repetition, and installable home-screen app support. PWA installation provides a standalone window; sign-in, translation, saved vocabulary, and reviews still require the network. No service worker or offline/private-data cache is installed, so app code updates are picked up when you reload or reopen the hosted app. PWA and deployment have shipped as separate follow-up phases.

## PWA installation

Webcards publishes a web app manifest, including install icons and standalone display mode. After updating an existing deployment, reload the hosted site to receive current installation metadata.

- **Android / desktop Chrome or Edge:** choose Install app or Add to Home screen from the browser menu (or its install icon). In-app browsers may not offer installation; open the address in Safari, Chrome, Edge, or another browser that supports PWA installation.
- **iPhone / iPad:** open the HTTPS site in Safari, tap Share, select Add to Home Screen, keep Open as Web App enabled if offered, and tap Add. Desktop-class iPads use the touch-screen device guidance.
- **Mac Safari:** choose File > Add to Dock. Installation options depend on browser and OS version.
- **Updates:** no app-store package or reinstall is required. The browser loads the current production site when the installed app is launched or reloaded. There is no offline cache or deferred app-update prompt.

## Phase 1

- Responsive, owner-only translator with both Russian-to-English and English-to-Russian directions, optional context, ambiguity questions, explicit-submit behavior, and retained input on errors.
- Maintained Better Auth username/password login; public signup is disabled. Owner creation is a one-time local CLI operation. Passwords are hashed with Better Auth's password implementation; sessions are stored in PostgreSQL.
- PostgreSQL-backed preferences (daily goal defaults to 12) and atomic per-owner/day translation-request limits. Better Auth schema updates and versioned, checksum-verified application migrations are separate.
- Server-only LiteLLM Responses adapter pinned to `chatgpt-gpt-6-luna`, with strict request/result validation, no provider-side response storage, a bounded SSE parser, one bounded retry, a 20-second overall deadline, and a two-request concurrency limit.
- Translation alone never creates a card or permanent translation history. A bounded in-process, 60-second translation request-ID replay window prevents retries from calling the model twice while the single local process is running.
- **Today** shows distinct cards reviewed against the daily goal, due cards and directions, and the local-day/timezone. There are no reminders or offline inference.

## Phase 2

- **Add to my list** saves just the chosen meaning, both language sides, context, usage note, original direction, and translation model/prompt metadata. Saved cards survive reload and a separate browser sign-in through PostgreSQL; saving makes no additional model call.
- Same-owner duplicates match the Russian side, English side, meaning, and context after Unicode NFC and whitespace normalization, regardless of original translation direction. Case, accents, and punctuation are preserved. A changed usage note alone does not create another card; use Edit card instead. Different senses or contexts may be separate cards.
- Saves and changes use durable, transactional request-ID receipts. Retrying an interrupted request does not duplicate a card or apply an edit twice. **Undo** deletes only a newly created, unchanged save, never a pre-existing duplicate or an edited card. Undo is available alongside that result, not after navigating away.
- **My list** supports literal, case-insensitive search in both languages, meaning, context, and notes; active/archived filters; and 50-card pages. Each card has a stable details link.
- Editing creates an immutable content version and preserves previous content and original translation metadata. Archive/restore preserves all versions. Restore or edit cannot create a second identical active card. Concurrent stale edits return a conflict and retain the unsaved draft for recovery.
- Confirmed permanent deletion removes the card and all content versions. Minimal idempotency receipts retain IDs and server-secret-keyed payload digests, not card text; they prevent a delayed retry from resurrecting a deleted card. Receipts persist until the owner is deleted. Rotating `BETTER_AUTH_SECRET` invalidates replay of earlier requests (they fail safely rather than being reapplied). Backup expiry and full account export/deletion are later personal-release work, not guarantees of this slice.

Existing local installations must run `npm run db:migrate` before starting this phase. Migration `0002_vocabulary` adds the card tables without replacing owner credentials or preferences. No review scheduler or attempt history is introduced by the vocabulary migration.

## Phase 3

- **Today** starts one resumable, server-owned review session. Sessions freeze a deterministic order, prioritize learning/relearning and overdue reviews, then include up to five newly introduced cards after due reviews. A session asks at most one direction per card; the other direction stays due in the backlog. Only one session per owner is active.
- **Russian to English** and **English to Russian** schedules are independent. PostgreSQL stores each direction's pinned `ts-fsrs@5.2.0` FSRS-6 state, due instant, concurrency revision, algorithm/parameters, and review history. The initial policy uses 90% desired retention, one-minute/ten-minute learning steps, one-minute relearning, and no random interval fuzz. Mistakes use FSRS Again; correct recall uses Good. No custom mistake-ranking overrides FSRS.
- **Type an answer** in the prompt's opposite language. Only Unicode NFC and whitespace are normalized for automatic exact matches; case, punctuation, accents, morphology, and meaning are not silently erased. Non-exact answers are checked against one saved meaning, context, and direction using the configured Luna route. Model grades cannot supply a reference answer or update schedules.
- **Uncertain judgments**, typos, timeouts, malformed model results, and outages never silently count as wrong. Show the saved reference and let the learner choose recalled/practice again, skip without a rating, or retry the same answer. A reveal counts as Again only when the learner explicitly continues with that result; self-assessment is recorded separately from the original verdict.
- **Transactional finalization** updates the attempt, answer, grade, and only its directional schedule together. Retried finalization returns the same result; stale content, stale schedules, or another tab cannot apply a second review. Edits preserve earlier review history and pause stale queued questions; use the card's explicit Reset learning control when its meaning changes. Reset clears both directional scheduler states but retains prior attempts.
- The grading budget defaults to at most 100 reserved upstream calls per owner per UTC day, configured through `GRADINGS_PER_DAY` (one non-exact grade reserves up to two bounded calls). Exact matches make no model request. **Review checks send the typed answer, saved meaning, and context to LiteLLM; provider retention remains unverified.**

Existing installations must run `npm run db:migrate` before starting this phase. Migration `0003_daily_review` adds per-direction schedules, resumable sessions, attempts, introductions, and grading budgets. It does not modify existing card content, owner credentials, or preferences.

## Requirements

- Node.js 22+, npm, and PostgreSQL 17+ on the local machine.
- A PostgreSQL role and database dedicated to Webcards; allow the app role to create its own schema/tables during the first migration. The application connects through a small bounded pool.
- A dedicated LiteLLM virtual key restricted to `chatgpt-gpt-6-luna`; never reuse a Pi, proxy-master, or other general-purpose credential.

No production host, public signup, reverse proxy, Docker deployment, production database, browser-side model credential, or live agent/service integration is configured by these local setup steps.

## Local setup

1. Create a private PostgreSQL database and a least-privilege application role. Grant it access only to that database and permission to create the application/authentication tables. Set `DATABASE_URL` to this database.
2. Copy `.env.example` to `.env.local`, make the copy owner-only (`chmod 600 .env.local`), and fill in `DATABASE_URL`, `BETTER_AUTH_URL=http://127.0.0.1:3000`, an unpredictable random `BETTER_AUTH_SECRET` of at least 32 characters, and a lowercase `OWNER_USERNAME`. Keep this file out of version control.
3. Install pinned dependencies: `npm ci`.
4. Apply the Better Auth and application migrations: `npm run db:migrate`.
5. Create the only owner. Type the password without echoing it to the terminal or putting it in command history:

   ```bash
   read -r -s -p 'Choose an owner password (12-128 characters): ' WEBCARDS_PASSWORD
   printf '\n'
   printf '%s\n' "$WEBCARDS_PASSWORD" | npm run owner:create
   unset WEBCARDS_PASSWORD
   ```

6. Set `LITELLM_BASE_URL=http://127.0.0.1:4000/v1`, `LITELLM_MODEL=chatgpt-gpt-6-luna`, and the dedicated `LITELLM_API_KEY` in `.env.local`.
7. Start the local-only app: `npm run dev`; open `http://127.0.0.1:3000`.

Database creation and the application credential are intentionally operator-managed; the project does not silently alter the shared PostgreSQL or LiteLLM service. `scripts/model-smoke.ts` runs one generic phrase in each direction when explicitly invoked via `npm run model:smoke`. This incurs real model requests; no quality benchmark or permitted-use/privacy review is implied.

The UI discloses that translation text and non-exact quiz answers (plus the relevant saved meaning and context) go through the configured LiteLLM upstream. Do not submit sensitive text until the upstream identity, subscription terms, retention policy, rate limits, and cost implications have been reviewed. Translation works online only. Keep the local listener bound to loopback; a publicly reachable instance is not a personal-use deployment plan.

## Verification

- `npm run typecheck` - TypeScript checking.
- `npm test` - contract, translation/grading model-protocol, FSRS policy, timezone, disposable PostgreSQL migration/authentication/quota, card/review isolation, idempotency, versioning, search, lifecycle, and PWA manifest/icon tests.
- `npm run test:browser` - authenticated translate/save/manage/review flows, PWA manifest and browser-install eligibility, install controls and platform-specific instructions at 390px and desktop sizes, against a disposable PostgreSQL cluster and a fake local model endpoint. The runner removes its temporary database when it exits. Set `POSTGRES_BIN` if PostgreSQL binaries are not in `/usr/lib/postgresql/17/bin`; install Chromium with `npx playwright install chromium` if needed.
- `npm run build` - production bundle and generated routes.

Automated tests never use the real LiteLLM endpoint. See [Phase 2 validation](docs/phase-2-validation.md) and [Phase 3 validation](docs/phase-3-validation.md) for earlier evidence. The authorized two-phrase real-route smoke check described in the [Phase 1 validation record](docs/phase-1-validation.md) validated transport/direction only; it is not the independent held-out Russian/English release benchmark described in the product plan. The [personal host deployment](docs/deployment.md) covers the current Caddy and systemd setup; [PWA validation](docs/pwa-validation.md) records installability checks and device-testing limits.
