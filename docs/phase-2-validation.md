# Phase 2 validation and release boundaries

## Scope

This local slice adds opt-in, per-meaning vocabulary saving and management. Translation itself still does not create a permanent history. A card contains Russian and English sides, a meaning, optional context and usage note, the original translation direction, and model/prompt provenance. Editing appends a content version; archive/restore retains versions; confirmed deletion removes the card and its versions. No quiz, review attempt, scheduler, due count, offline inference, installation, or deployment is included.

The duplicate key is the same owner's normalized Russian side, English side, sense, and context, independent of original direction. Unicode NFC and whitespace are normalized without discarding case, accents, or punctuation. Notes do not distinguish duplicates. An active duplicate is linked instead of saved twice; separate senses or contexts can coexist. An archived card can coexist with an active duplicate, but restore is rejected until the conflict is resolved.

Writes are owner-scoped, origin-checked, bounded, and transactional. Durable request receipts make identical retries safe. Receipt payload digests are keyed using the application secret; receipts retain IDs and digests rather than card text. After a secret rotation, old requests fail safely rather than replaying. Undo is restricted to an unchanged card actually created by that save; it cannot delete an existing duplicate or a later edit. Edits and status changes use an optimistic revision, so another tab cannot silently overwrite a changed card.

## Automated checks

- `npm run typecheck` and `npm run build` pass.
- `npm test` passes 57 unit/integration tests against fake model responses and disposable PostgreSQL. Phase 2 coverage includes migration from a populated owner foundation, Unicode normalization, reverse-direction and simultaneous duplicate saves, independent senses, durable save/change replay, secret rotation, owner isolation, lost-response undo, content versions, competing changes, restore collisions, hard deletion, bounded/validated APIs, literal Unicode search, and pagination.
- `npm run test:browser` passes 13 Chromium scenarios against a separate disposable PostgreSQL cluster and fake model endpoint. Coverage includes mobile (390px) and desktop translation/save/search/edit/archive/restore/delete, alternative selection, duplicate behavior, retry after a committed response is lost, stale-tab draft preservation, a separate browser sign-in, protected access after logout, loading errors, and overflow checks. Screenshots of the list, card, and editor are generated under `test-results/`.
- Playwright now requests graceful server shutdown so the test fixture can stop PostgreSQL and remove its temporary directory. A before/after process and directory check verified that the final browser run left no new test database or port 33117 listener. Six older test PostgreSQL processes were already present before this work and were left untouched.
- Validation makes no live inference calls and provisions no persistent database, owner, credential, or service. The Phase 1 two-phrase live-route smoke check remains documented separately in [phase-1-validation.md](phase-1-validation.md).

## Remaining boundaries

- The independent Russian/English model quality benchmark, subscription/automated-use terms, upstream identity, privacy/retention, costs, and personal-release approval remain open. A fake model or the earlier two-phrase smoke check is not a quality evaluation.
- Durable receipts are retained until owner deletion; changing `BETTER_AUTH_SECRET` invalidates old receipt comparisons and existing sessions. The application does not yet provide account-wide export/deletion, retention controls, backup expiration, or a tested backup/restore workflow. Database or backup storage can contain personal card content until separately managed.
- The authentication and operations are for the local, single-process development boundary. Cross-device persistence was tested using separate browser sessions on the local test server; no network-accessible host, HTTPS deployment, or real-device access has been configured or approved.
- At Phase 2 validation, review scheduling, reset behavior, and grading remained future work, and no card was claimed to be due or reviewed. See [Phase 3 validation](phase-3-validation.md) for the later review implementation. Accepted answer variants, reminders, and PWA/offline behavior remain future work.
