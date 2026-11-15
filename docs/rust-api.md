# Rust API migration

The existing static React/Vite frontend, Caddy routes, PostgreSQL schema, and browser contracts stay unchanged. The standalone API is being replaced with a Rust/Axum binary; no migration is added. PostgreSQL remains the source of truth for authentication sessions, private accounts, vocabulary, retry receipts, review queues/history, and FSRS schedules. The Rust process must continue to listen on `127.0.0.1` behind Caddy and load the same server-only `.env.local` values. Public signup remains disabled.

## Compatibility guarantees

- Existing Better Auth username/password hashes are verified directly (scrypt N=16384, r=16, p=1, 64-byte key, NFKC password normalization, and the original ASCII-hex salt). The Better Auth HMAC-SHA256 cookie name, signature, expiry, and `__Secure-` HTTPS prefix are retained. A Node-issued session can be used by Rust, and a Rust-issued session can be used by Node. Expired/revoked sessions and accounts without `owner_preferences` fail closed. Seven-day sessions renew after the existing one-day update age.
- The Rust card API reads and writes the same tables and preserves the Node HMAC receipt payload field ordering. Cross-runtime retries cannot reapply a save or edit. Card versions, account scoping, archive/restore, undo, delete, reset, search, and conflicts remain intact.
- Review queue construction, per-day retirement, independent directions, idempotent finalization, uncertain grading, and server-day/timezone boundaries use the existing schema and transactions. The Rust FSRS-6 long-term scheduler is regression-tested against 120 fixtures from the currently pinned `ts-fsrs@5.2.0` implementation; the source library's MIT notice is retained in `licenses/ts-fsrs.txt`.
- Translation and grading requests retain the current Luna alias, Responses API request shape, JSON contracts, output-size bound, deadline, retry, budget reservation, origin checks, and translation idempotency window. Model credentials are never exposed to Vite or the browser.
- The server enforces loopback binding, a 16 KiB request limit, no-store/security headers, a five-connection PostgreSQL pool, a five-second SQL statement timeout, and graceful shutdown. Do not trust caller-supplied forwarding headers for authentication or login limits.

## Development and verification

- Requirements: Rust 1.94.1, Cargo, Node.js 22.12+, npm, Caddy 2, and PostgreSQL 17+ for the existing frontend/browser fixtures.
- `npm ci` installs only the unchanged frontend/browser dependencies.
- `npm run dev` runs the Cargo API and Vite frontend; the API binds loopback `PORT` (default 3001). `npm run build` builds the frontend and optimized `dist/webcards-api` binary. `npm start` runs that binary with `.env.local`.
- `npm run typecheck` checks the unchanged frontend. `npm test` checks the existing TypeScript services plus live cross-runtime Rust/PostgreSQL integration tests (password/cookie interoperability, existing and new retry receipts, concurrent model-call replay, grading, account isolation, >200-card queues, local-midnight mistakes, and Node revocation of Rust sessions). It builds the Rust binary before testing.
- `npm run test:rust` and `npm run check:rust` run Cargo tests and warning-free Clippy, respectively. The Rust unit tests cover routing/method/body/origin/login limits, Better Auth scrypt and cookie compatibility, SSE, strict model contracts, and FSRS parity.
- `npm run test:browser` uses the actual Caddy configuration with disposable PostgreSQL and a fake model. Set `WEBCARDS_CADDY_BIN` when Caddy is not on `PATH`; set `POSTGRES_BIN` if PostgreSQL 17 binaries are in a different directory. Run `WEBCARDS_E2E_HTTPS=1 npm run test:browser` separately to validate secure session cookies over isolated Caddy HTTPS.
- Tests never call the configured production model, use the production database, install system packages, or modify the active service. Build/test Rust in an isolated checkout before any release.

## Isolated runtime snapshot

A disposable, same-host snapshot after sign-in, session/card/review reads, one fake translation, and two idle seconds measured the Rust binary at 9,672 KiB RSS / 7,039 KiB PSS and the existing bundled Node/Hono API at 123,160 KiB RSS / 73,382 KiB PSS. Both ran through the same real Caddy fixture and disposable PostgreSQL; these are one-process point-in-time measurements, not controlled benchmarks or a promise of production savings. PostgreSQL, Caddy, compilation, disk use, steady-state load, and session duration are excluded. The Rust release binary was 8.2 MiB.

## Deployment boundary

The checked-in `infra/webcards.service` starts `dist/webcards-api`, but changing a checkout or service file does not authorize a production cutover. The active API, production PostgreSQL, Caddy container/mounts, credentials, and public deployment remain untouched. A separate, explicit release approval should stage the binary and static assets in a versioned release; verify login and cross-runtime sessions, both accounts, translation, card CRUD, review completion and next-day behavior over HTTPS; inspect resource usage; preserve a rollback target; then separately approve the actual service/Caddy restart. No live inference or destructive schema changes are needed for the Rust migration.
