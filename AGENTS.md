# Webcards

- The frontend is a static React/Vite SPA in src/frontend, served by Caddy.
- The loopback-only Rust API lives in src/*.rs. The TypeScript services in src/lib remain the compatibility reference and power local account provisioning and migrations. Keep database, auth, and model credentials on the server; never use VITE_ variables for secrets.
- Preserve account isolation, origin checks, request limits, and transactional retry protection.
- Run typecheck, Rust tests and Clippy, unit/integration tests, production build, and browser tests after changes. Browser tests use the real Caddy configuration, disposable PostgreSQL, and a fake model endpoint; set WEBCARDS_CADDY_BIN if caddy is not on PATH.
- Work in an isolated checkout when validating changes to an active deployment. Do not replace its build output, install dependencies, alter production data, call the live model, or restart services without approval.
