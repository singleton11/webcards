# Personal deployment

Webcards has two runtime pieces: a static React/Vite frontend served directly by Caddy, and a loopback-only Node API on 127.0.0.1:3001. PostgreSQL, account provisioning, Better Auth sessions, review schedules, and the LiteLLM adapter remain unchanged on the private API. Public signup stays disabled. There is no database migration for this architectural change.

## Build and service

Run the same test, build, and deployment approval gates that apply to other releases. Use a separate checkout or isolated worktree: the running service's working tree and .env.local are not safe places for development or validation builds. Run `npm ci` (including build dependencies), then `npm run build`.

The service template `infra/webcards.service` sets its working directory to `/srv/webcards`, reads `.env.local` using systemd `EnvironmentFile`, and runs `node dist/server.mjs`. The API listens on 127.0.0.1:3001. The static site lives in dist/frontend; Node does not serve it. The API service receives .env.local and retains all existing database, auth, and model credentials. The frontend build uses no VITE_* configuration or provider credentials.

For local development, npm run dev starts Vite at http://127.0.0.1:3000 and the API on loopback port 3001. The Vite dev proxy sends /api/* to the API. For production validation, run typechecking, unit/integration tests, and the Playwright suite; its fixture builds the release assets, starts a disposable PostgreSQL cluster and fake model, and serves the bundle through an isolated Caddy process. The HTTPS browser suite uses a temporary isolated CA and does not modify the system trust store.

## Caddy

The maintained infra/Caddyfile serves files from /srv/webcards/dist/frontend, applies security and cache headers, and proxies only /api/* to the API. Client-side card routes such as /list/<uuid> fall back to the static index.html app shell. The API has independent body-size, origin, authentication, and no-store protections. Static JavaScript uses hashed filenames and immutable caching; app HTML and private API responses use no-store.

The personal deployment runs Caddy inside Docker with host networking. Its read-only static-file mount contains versioned frontend releases and a relative `current` symlink; the Webcards site root points at that symlink. Only `/api/*` is reverse-proxied to 127.0.0.1:3001. For another host, provide a read-only mount for the frontend bundle, update the Webcards site block using `infra/Caddyfile`, and configure WEBCARDS_STATIC_ROOT to the mounted path (for example /srv/webcards/dist/frontend). Keep Caddy's existing service sites, volumes, restart policy, network mode, TLS storage, and other unrelated configuration unchanged. Validate the effective Caddy configuration inside its container before applying it. Use the complete maintained directives in `infra/Caddyfile`; it also configures response compression, security headers, immutable asset caching, and the PWA manifest MIME type. Do not mount .env.local, .git, PostgreSQL files, or the API bundle into the Caddy container. Never expose the API outside loopback or publish database, auth, or model credentials to the browser.

## Cutover

The personal deployment now uses the static frontend and Node API. Its service runs a versioned API release outside the source checkout, with the existing private configuration supplied through systemd. The previous Next.js build and its dependencies are retained in an independent rollback release. Host-specific paths and the rollback command are recorded in the ignored `.local/` directory, not in public configuration. Creating a build or editing this repository does not authorize changing services on another host. An explicitly approved production cutover should build and stage a versioned release directory, validate its static assets and API without production requests, make the static bundle visible read-only to Caddy, switch Caddy's site block, restart/replace the Node API unit, and verify HTTPS, login/logout, API access controls, static asset caching, deep links, and runtime memory. Retain the previous release bundle, Caddy configuration, unit file, and Node dependency tree for a prompt rollback; switch Caddy back to the existing Node-served site and restore the earlier API unit if validation fails. No database migration, reset, or manual data modification is needed; login/logout verification naturally reads the database and updates sessions. Do not change the auth/session secret or LiteLLM key during this cutover.

## Operations

- API status: systemctl --user status webcards.service
- API logs: journalctl --user -u webcards.service -n 100 --no-pager
- Static build output: dist/frontend/
- Caddy's configuration and site routing are managed with the existing host Caddy deployment, not this systemd user service.

Webcards remains online-only, with no service worker or offline data cache. Translation and non-exact quiz grading continue to send text to the configured LiteLLM upstream; its retention policy has not been verified. Keep sensitive text out until upstream handling is reviewed. Backup/restore, account export/deletion, and provider privacy/terms review remain out of scope for this change.
