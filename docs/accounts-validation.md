# Private account provisioning validation

Validated on 2026-11-14.

## Scope

- Public signup stays disabled. `owner:create` remains the first-account-only bootstrap; `account:create -- <username>` provisions additional accounts from the trusted host, reading the password from stdin.
- Account creation writes the Better Auth user, hashed credential, and default preferences in one transaction. Existing usernames are rejected without changing their credentials or data, including concurrent attempts.
- Workspace access requires a valid database-backed Better Auth session and provisioned preferences, rather than a match against the initial `OWNER_USERNAME`. Each account owns its existing `owner_id`-scoped workspace; no schema migration or data copy is necessary.
- Vocabulary, search, duplicate detection, request receipts, translation budgets, review queues, schedules, and daily progress remain separate. The server-side model credential and bounded inference capacity remain shared; this is not a public multi-tenant service.

## Automated checks

- `npm run typecheck`: passed.
- `npm test`: 95 tests passed, including nine private-account integration tests with disposable PostgreSQL.
- `npm run test:browser`: 32 Chromium scenarios passed, including signing in to an additional account and verifying its list is empty despite the first account having saved vocabulary.
- `npm run build`: passed in an isolated validation copy and during the authorized production update.

Integration coverage includes both accounts signing in, credential hashing and default preferences, invalid and duplicate provisioning, public signup rejection, same-request-ID saves in separate workspaces, cross-account reads and every card mutation, foreign review attempts and session-ending, unchanged foreign schedules, separate daily counts and translation quotas, and rejection of authenticated identities lacking a provisioned workspace.

## Authorized activation

The service was stopped before replacing its production build and restarted after a successful build; the previous build was retained locally. Additional-account credentials were generated randomly and written to a mode-0600 file outside the repository. Provisioning left the existing owner's credentials, preferences, saved card versions, review schedules, and review events unchanged.

Public HTTPS browser checks verified both accounts can sign in, the new account starts with an empty workspace and a daily goal of 12 in UTC, an existing owner's card returns 404 to the new account, and logout revokes API access. Test sign-in sessions were logged out. The service and HTTPS login page are healthy.

No live model requests, schema changes, or modifications to the existing owner's password were needed. Disposable test PostgreSQL clusters and browser listeners were cleaned up. Backup/restore, account export/deletion, and provider privacy/terms remain outside this change.
