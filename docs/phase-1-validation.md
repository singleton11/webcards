# Phase 1 validation and release boundaries

## Authorized real-route smoke test

On 13 November 2026, the operator authorized live inference. A temporary LiteLLM key was created for `chatgpt-gpt-6-luna` only, limited to one concurrent request and short-lived, and revoked immediately after the test. No key value was printed or saved to this project. The local proxy reported healthy, and its configured alias mapped to `chatgpt/gpt-6-luna` at the time of the check.

The actual application adapter sent one generic greeting in each direction using the Responses streaming endpoint and the strict JSON schema:

| Direction          | Input       | Result       | Calls | Elapsed |
| ------------------ | ----------- | ------------ | ----- | ------- |
| Russian to English | Доброе утро | Good morning | 1     | 1.99 s  |
| English to Russian | Thank you   | Спасибо      | 1     | 1.64 s  |

Both returned schema-valid results and usage metadata. These two examples demonstrate route and response-contract compatibility, not translation quality, grading quality, p95 latency, subscription eligibility, privacy, or provider retention. The test credential was not retained for application use.

## Automated checks

The current slice passes TypeScript checking, all 37 unit/integration tests, all 5 Chromium browser scenarios, formatting checks, and a production build.

`npm test` uses a disposable PostgreSQL cluster and fake HTTP responses. It exercises authentication, logout, registration and origin guards, password rate limiting, atomic usage limits, migration checksums, request replay and concurrency, model failures and deadlines, schema parsing, and both language directions. `npm run test:browser` runs Chromium against a separate disposable PostgreSQL cluster and fake LiteLLM endpoint at mobile and desktop sizes. It verifies the protected navigation, sign-in/sign-out, ambiguity flow, direction swap, request retry identity, input preservation, and the absence of horizontal overflow at 390px.

## Not yet approved or established

- The independent development and held-out Russian/English translation and grading benchmarks in the product plan have not been run. Two smoke examples are not a model quality gate.
- The exact subscription terms, permitted automated access, upstream retention, rate limits, and incremental charges remain to be verified before real personal text is submitted. `store: false` is a request parameter, not a verified provider-retention guarantee.
- Single-owner authentication is for the local development boundary. Multi-instance rate limiting, distributed replay/concurrency, HTTPS ingress, deployment security, backup/restore, and operational recovery require separate design and verification before remote or personal release.
- The app has not been deployed, a persistent owner/database has not been provisioned, and no ongoing application model credential has been created. Vocabulary saving, quizzes, review scheduling, offline support, installation, and personal-data export/deletion remain future phases.
