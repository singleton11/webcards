# Rust API validation

Validated in an isolated checkout with Rust 1.94.1, disposable PostgreSQL 17, the repository's real Caddy configuration, and fake model responses. The source checkout's build output, installed dependencies, production PostgreSQL, live model, Caddy configuration, and active Node service were not modified.

## Checks

- `npm run typecheck`: passed.
- `npm run test:rust`: 9 Rust tests passed, including 120 FSRS transition fixtures generated from pinned `ts-fsrs@5.2.0`.
- `npm run check:rust`: Clippy passed with warnings denied.
- `npm test`: 120 tests passed (111 existing reference/service tests and 9 cross-runtime PostgreSQL/API tests).
- `npm run build`: static frontend and optimized Rust binary built successfully.
- HTTP browser suite: 39 passed, with the HTTPS-only scenario skipped.
- Isolated HTTPS browser suite: all 40 scenarios passed, including Secure/HttpOnly cookies and hostile-origin rejection. The temporary CA was not installed into system trust.

## Cross-runtime evidence

The integration suite uses one disposable database to prove that Rust accepts a real Node-issued Better Auth session, Node accepts and revokes a Rust-issued session, and neither accepts a forged cookie. It verifies Node-to-Rust and Rust-to-Node durable save receipts, Node edit receipt replay in Rust, request-ID conflicts, in-flight translation deduplication and conflict handling, a disconnected translation client, duplicate grading requests, transactional finalization, private account/card isolation, continuation in Node of an FSRS state written by Rust, one 205-card queue, next-local-midnight mistake scheduling, and existing-session renewal.

The browser suites cover translator ambiguity and both language directions, save/undo/edit/version/archive/restore/delete flows, stale edits and response-loss retries, private accounts, exact and model-checked reviews, reveal/uncertain/self-assessed answers, hidden meaning hints, unlimited quizzes, stale queued content, PWA assets/installability, same-origin protections, request limits, deep links, and Caddy cache/security behavior on mobile and desktop.

## Resource snapshot

An additional isolated same-host smoke comparison performed sign-in, session/card/review reads, one fake translation, and a two-second idle period for both backends:

| Process | RSS | PSS |
| --- | ---: | ---: |
| Rust API | 9,672 KiB | 7,039 KiB |
| Existing Node/Hono API | 123,160 KiB | 73,382 KiB |

The Rust binary is approximately 8.2 MiB. These are point-in-time application-process measurements, not a production benchmark, steady-state load test, or total-stack memory claim. PostgreSQL, Caddy, the fake model, and compiler/build memory are excluded.

## Boundaries

No production deployment, restart, database migration, account provisioning, password change, or live inference occurred. Existing Node code remains as a compatibility oracle and supports the unchanged local migration/account tools; the release API is native Rust and does not call a Node sidecar. Runtime authentication is security-sensitive new code rather than the Better Auth package itself, so independent review remains prudent before a separately approved cutover. Held-out model quality, upstream retention/terms, backups, and account export/deletion remain outside this rewrite.
