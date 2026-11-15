# Webcards

- The frontend is a static React/Vite SPA in src/frontend, served by Caddy.
- The loopback-only Node/Hono API reuses the services in src/lib. Keep database, auth, and model credentials on the server; never use VITE_ variables for secrets.
- Preserve account isolation, origin checks, request limits, and transactional retry protection.
- Run typecheck, unit/integration tests, production build, and browser tests after changes. Browser tests use the real Caddy configuration, disposable PostgreSQL, and a fake model endpoint; set WEBCARDS_CADDY_BIN if caddy is not on PATH.
- Work in an isolated checkout when validating changes to an active deployment. Do not replace its build output, install dependencies, alter production data, call the live model, or restart services without approval.
