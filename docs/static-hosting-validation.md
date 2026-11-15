# Static frontend validation

The static React/Vite frontend and loopback Node API are validated in an isolated checkout, not the active deployment directory. Caddy serves the built files and proxies same-origin API requests; the test fixture uses disposable PostgreSQL, a fake LiteLLM endpoint, and a copied Caddy executable matching the deployed container. There are no live model calls, schema migrations, production database changes, container restarts, or Caddy configuration changes.

- npm ci, typecheck, production frontend/API build, and 111 unit/integration tests pass.
- 39 HTTP browser scenarios pass, with the HTTPS-only scenario skipped. All 40 browser scenarios pass over isolated HTTPS with a temporary Caddy CA that is not installed into the system trust store.
- Browser coverage includes both viewports, translation and saved vocabulary, review flows, existing per-account isolation, origin rejection, secure and HttpOnly HTTPS cookies, logout, deep links, API and missing-asset routing, immutable asset and no-store response headers, PWA installability, 16 KiB API body limit, and recovery from session outages.
- Local development mode is verified using a disposable PostgreSQL cluster and alternate loopback ports. All disposable PostgreSQL clusters and app processes terminate, and test ports are released.
- In a single point-in-time measurement after a fixture login and review load, the test API was 117,516 KiB RSS / 63,850 KiB PSS. The already-running production Next.js process measured 154,424 KiB RSS / 98,965 KiB PSS. These are different processes, datasets, build environments, and usage histories: the comparison is illustrative, not a controlled production benchmark. Both figures exclude PostgreSQL and Caddy, which remain shared. Real-world savings require measuring after deployment under comparable load.

## Production cutover

The operator-approved cutover on 2026-11-15 deploys the static frontend through a read-only mount in the existing Caddy container and runs the API from a versioned release outside the source checkout. The previous Next.js build and its dependencies are preserved independently, with configuration backups and a rollback script. Caddy image, host networking, restart policy, TLS/config volumes, and unrelated site routing remain unchanged.

- Production-only dependency installation passes without legacy peer resolution. React Router is pinned to 7.18.5, compatible with the existing React 19.2.4; all 111 unit/integration tests and 40 HTTPS browser scenarios pass after this adjustment.
- Live HTTPS validation checks both existing accounts, Secure/HttpOnly cookies, English default source language, vocabulary and Today pages at 390px and desktop sizes, card deep links/reload, cross-account card rejection, logout/token revocation, no private offline cache, PWA metadata, manifest/icons, exact static asset checksums, immutable asset caching, and anonymous/untrusted-origin API rejection. No translation or review action is submitted.
- All unrelated Caddy host status codes match their pre-cutover baselines and TLS remains valid. Hedgehoog already returned 502 before this cutover and remains unchanged.
- Point-in-time application-process memory after the live checks is 94,512 KiB RSS / 41,810 KiB PSS, compared with 155,892 KiB RSS / 101,558 KiB PSS immediately before the cutover. This is approximately 60 MiB lower RSS; process lifetimes and workload history differ, and the figures exclude shared PostgreSQL and Caddy.
- The API remains loopback-only and the systemd unit remains enabled for boot. No schema migration, learning reset, credential rotation, or live model request is performed; login verification updates only ordinary authentication sessions.

Existing provider privacy/terms review, independent model-quality evaluation, and backup/restore limitations remain unchanged.
