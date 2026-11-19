# Webcards

A private Russian/English translator with an opt-in personal vocabulary list, daily typed reviews with spaced repetition, and installable home-screen app support. PWA installation provides a standalone window; sign-in, translation, saved vocabulary, and reviews still require the network. No service worker or offline/private-data cache is installed, so app code updates are picked up when you reload or reopen the hosted app. PWA and deployment have shipped as separate follow-up phases.

## Architecture

The browser downloads a static React/Vite frontend. Caddy serves those files and proxies same-origin `/api/*` requests to a loopback-only Rust API. Authentication, account isolation, PostgreSQL, model requests, and review scheduling stay on the server; static files contain no application credentials or vocabulary. The Rust binary preserves the existing PostgreSQL schema and Better Auth credentials/sessions; no database migration is required. Node.js is used for frontend builds, tests, and existing administrative scripts, not to run the production API.

See [Rust API migration](docs/rust-api.md) for compatibility, validation, and deployment boundaries.

See [deployment](docs/deployment.md) for the Caddy configuration, static file mount, and deployment safety notes.

## PWA installation

Webcards publishes a web app manifest, including install icons and standalone display mode. After updating an existing deployment, reload the hosted site to receive current installation metadata.

- **Android / desktop Chrome or Edge:** choose Install app or Add to Home screen from the browser menu (or its install icon). In-app browsers may not offer installation; open the address in Safari, Chrome, Edge, or another browser that supports PWA installation.
- **iPhone / iPad:** open the HTTPS site in Safari, tap Share, select Add to Home Screen, keep Open as Web App enabled if offered, and tap Add. Desktop-class iPads use the touch-screen device guidance.
- **Mac Safari:** choose File > Add to Dock. Installation options depend on browser and OS version.
- **Updates:** no app-store package or reinstall is required. The browser loads the current production site when the installed app is launched or reloaded. There is no offline cache or deferred app-update prompt.

## Phase 1

- Responsive private-workspace translator with separate credentials, vocabulary, and review progress for each locally provisioned account. Russian-to-English and English-to-Russian directions, optional context, ambiguity questions, explicit-submit behavior, and retained input on errors.
- Private username/password login compatible with the existing Better Auth password hashes and signed sessions; public signup is disabled. Accounts are provisioned only through a trusted local CLI operation using Better Auth's password implementation. Rust verifies the hashes and stores sessions in PostgreSQL.
- PostgreSQL-backed per-account preferences and atomic per-account/day translation-request limits. The legacy daily-goal preference is retained in storage but no longer limits or appears in the quiz. Better Auth schema updates and versioned, checksum-verified application migrations are separate.
- Server-only Responses adapter for CLIProxyAPI pinned to `gpt-6-luna`, with strict request/result validation, no provider-side response storage, a bounded SSE parser, one bounded retry, a 20-second overall deadline, and a two-request concurrency limit.
- Translation alone never creates a card or permanent translation history. A bounded in-process, 60-second translation request-ID replay window prevents retries from calling the model twice while the single local process is running.
- **Today** shows distinct cards reviewed, eligible due cards and directions, and the server-configured day/timezone (UTC in the current deployment). There is no daily quiz length or new-card cap. There are no reminders or offline inference.

## Phase 2

- **Add to my list** saves just the chosen meaning, both language sides, context, usage note, original direction, and translation model/prompt metadata. Saved cards survive reload and a separate browser sign-in through PostgreSQL; saving makes no additional model call.
- Same-owner duplicates match the Russian side, English side, meaning, and context after Unicode NFC and whitespace normalization, regardless of original translation direction. Case, accents, and punctuation are preserved. A changed usage note alone does not create another card; use Edit card instead. Different senses or contexts may be separate cards.
- Saves and changes use durable, transactional request-ID receipts. Retrying an interrupted request does not duplicate a card or apply an edit twice. **Undo** deletes only a newly created, unchanged save, never a pre-existing duplicate or an edited card. Undo is available alongside that result, not after navigating away.
- **My list** supports literal, case-insensitive search in both languages, meaning, context, and notes; active/archived filters; and 50-card pages. Each card has a stable details link.
- Editing creates an immutable content version and preserves previous content and original translation metadata. Archive/restore preserves all versions. Restore or edit cannot create a second identical active card. Concurrent stale edits return a conflict and retain the unsaved draft for recovery.
- Confirmed permanent deletion removes the card and all content versions. Minimal idempotency receipts retain IDs and server-secret-keyed payload digests, not card text; they prevent a delayed retry from resurrecting a deleted card. Receipts persist until the owner is deleted. Rotating `BETTER_AUTH_SECRET` invalidates replay of earlier requests (they fail safely rather than being reapplied). Backup expiry and full account export/deletion are later personal-release work, not guarantees of this slice.

Existing local installations must run `npm run db:migrate` before starting this phase. Migration `0002_vocabulary` adds the card tables without replacing owner credentials or preferences. No review scheduler or attempt history is introduced by the vocabulary migration.

## Phase 3

- **Today** starts one resumable, server-owned review queue containing all currently eligible cards, without a daily goal, new-card cap, session-size cap, or scan limit. Missed and previously introduced due cards come before new cards, but never block them. The order is frozen so reloads resume the same question. Only one queue per account is active.
- **One appearance per card per day:** finalizing either a correct or incorrect answer hides the whole card in both directions for the rest of the configured server day. A missed card returns at the next calendar midnight, with its missed direction prioritized. Correct recall follows FSRS and is never requeued the same day. Once the queue is exhausted, Today shows that you are caught up. Newly saved cards can start another queue today. Unrated skips and ending a queue do not change schedules or retire a card for the day.
- **Russian to English** and **English to Russian** schedules remain independent. PostgreSQL stores each direction's FSRS-6 state, due instant, concurrency revision, algorithm/parameters, and review history. The Rust implementation is tested against the pinned `ts-fsrs@5.2.0` behavior. Policy `webcards-v2` uses 90% desired retention, no random interval fuzz, and day-scale FSRS with short-term learning/relearning disabled. Mistakes still train FSRS with Again, but their due time is overridden to next midnight; correct recall uses Good and keeps its FSRS interval. The opposite direction retains its own due time, but cannot be asked until a later day.
- **Type an answer** in the prompt's opposite language. Only Unicode NFC and whitespace are normalized for automatic exact matches; case, punctuation, accents, morphology, and meaning are not silently erased. Non-exact answers are checked against one saved meaning, context, and direction using the configured Luna route. Model grades cannot supply a reference answer or update schedules.
- **Uncertain judgments**, typos, timeouts, malformed model results, and outages never silently count as wrong. Show the saved reference and let the learner choose recalled/review tomorrow, skip without a rating, or retry the same answer. A reveal counts as Again only when the learner explicitly continues with that result; self-assessment is recorded separately from the original verdict.
- **Transactional finalization** updates the attempt, answer, grade, and only its directional schedule together. Retried finalization returns the same result; stale content, stale schedules, or another tab cannot apply a second review. Edits preserve earlier review history and pause stale queued questions; use the card's explicit Reset learning control when its meaning changes. Reset clears both directional scheduler states but retains prior attempts.
- The grading budget defaults to at most 100 reserved upstream calls per owner per UTC day, configured through `GRADINGS_PER_DAY` (one non-exact grade reserves up to two bounded calls). Exact matches make no model request. **Review checks send the typed answer, saved meaning, and context to the configured model upstream; provider retention remains unverified.**

Existing installations must run `npm run db:migrate` before starting this phase. Migration `0003_daily_review` adds per-direction schedules, resumable sessions, attempts, introductions, and grading budgets. It does not modify existing card content, owner credentials, or preferences. The unlimited-queue/day-only follow-up requires no new migration or learning reset: existing history is preserved, old same-day queued repeats are discarded on resume, and future finalized answers use the versioned new policy. See [Quiz policy validation](docs/quiz-policy-validation.md).

## Requirements

- Rust 1.94.1, Cargo, Node.js 22.12+, npm, and PostgreSQL 17+ for development and validation. Caddy 2 is required for production static hosting and browser tests. The production API itself runs as the compiled Rust binary without Node.js.
- A PostgreSQL role and database dedicated to Webcards; allow the app role to create its own schema/tables during the first migration. The application connects through a small bounded pool.
- A dedicated Webcards API key in CLIProxyAPI; never reuse another application's key or OAuth credentials. Keep the proxy's host port bound to loopback.

No production host, public signup, reverse proxy, Docker deployment, production database, browser-side model credential, or live agent/service integration is configured by these local setup steps.

## Local setup

1. Create a private PostgreSQL database and a least-privilege application role. Grant it access only to that database and permission to create the application/authentication tables. Set `DATABASE_URL` to this database.
2. Copy `.env.example` to `.env.local`, make the copy owner-only (`chmod 600 .env.local`), and fill in `DATABASE_URL`, `BETTER_AUTH_URL=http://127.0.0.1:3000`, an unpredictable random `BETTER_AUTH_SECRET` of at least 32 characters, and a lowercase `OWNER_USERNAME`. Keep this file out of version control.
3. Install pinned dependencies: `npm ci`.
4. Apply the Better Auth and application migrations: `npm run db:migrate`.
5. Create the initial owner. Type the password without echoing it to the terminal or putting it in command history:

   ```bash
   read -r -s -p 'Choose an owner password (12-128 characters): ' WEBCARDS_PASSWORD
   printf '\n'
   printf '%s\n' "$WEBCARDS_PASSWORD" | npm run owner:create
   unset WEBCARDS_PASSWORD
   ```

6. To provision another separate private account locally, pass its lowercase username as an argument and its password via stdin. Public registration remains disabled; each account receives its own empty vocabulary, review progress, quota, and preferences:

   ```sh
   read -r -s -p 'Choose an account password (12-128 characters): ' WEBCARDS_PASSWORD
   printf '\n'
   printf '%s\n' "$WEBCARDS_PASSWORD" | npm run account:create -- wife
   unset WEBCARDS_PASSWORD
   ```

7. Set `MODEL_BASE_URL=http://127.0.0.1:18317/v1`, `MODEL_NAME=gpt-6-luna`, and the dedicated `MODEL_API_KEY` in `.env.local`.
8. Start the local-only app: `npm run dev`; open `http://127.0.0.1:3000`. Vite serves the frontend on port 3000 and proxies `/api/*` to the API on loopback port 3001. If those ports are occupied, set `WEBCARDS_DEV_PORT` and `PORT` in the environment before starting, and set `BETTER_AUTH_URL` in `.env.local` to the matching frontend origin. In production, `npm run build` creates `dist/frontend` and `dist/webcards-api`; `npm start` runs only the Rust API, so a static host such as Caddy must serve the frontend.

Database creation and the application credential are intentionally operator-managed; the project does not silently alter the shared PostgreSQL or CLIProxyAPI service. `scripts/model-smoke.ts` runs one generic phrase in each direction when explicitly invoked via `npm run model:smoke`. This incurs real model requests; no quality benchmark or permitted-use/privacy review is implied.

The UI discloses that translation text and non-exact quiz answers (plus the relevant saved meaning and context) go through the configured model proxy to OpenAI. Do not submit sensitive text until the upstream identity, subscription terms, retention policy, rate limits, and cost implications have been reviewed. Translation works online only. Keep the local listener bound to loopback; a publicly reachable instance is not a personal-use deployment plan.

## Verification

- `npm run typecheck` - TypeScript checking.
- `npm test` - existing contract/service suites plus cross-runtime Rust/PostgreSQL authentication, receipt, scheduling, isolation, and retry tests. Builds the Rust API first.
- `npm run test:rust` and `npm run check:rust` - Rust unit tests and Clippy.
- `npm run test:browser` - builds the frontend and API, then exercises real Caddy routing, authenticated translate/save/manage/review flows, PWA installability, mobile and desktop layouts, against disposable PostgreSQL and a fake model endpoint. The runner removes its temporary database when it exits. Set `POSTGRES_BIN` if PostgreSQL binaries are not in `/usr/lib/postgresql/17/bin`, set `WEBCARDS_CADDY_BIN` if Caddy is not on `PATH`, and install Chromium with `npx playwright install chromium` if needed.
- `WEBCARDS_E2E_HTTPS=1 npm run test:browser` - run the same browser tests through isolated HTTPS with a temporary, untrusted Caddy CA; no system trust store is modified.
- `npm run build` - build static frontend files and the standalone Rust API binary.

Automated tests never use the real model endpoint. See [Phase 2 validation](docs/phase-2-validation.md) and [Phase 3 validation](docs/phase-3-validation.md) for earlier evidence. The authorized two-phrase real-route smoke check described in the [Phase 1 validation record](docs/phase-1-validation.md) validated transport/direction only; it is not the independent held-out Russian/English release benchmark described in the product plan. The [personal host deployment](docs/deployment.md) covers the current Caddy and systemd setup; [PWA validation](docs/pwa-validation.md) records installability checks and device-testing limits.
