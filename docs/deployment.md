# Personal deployment

Webcards is designed for a single owner behind an HTTPS reverse proxy such as Caddy. Keep the Next.js listener private at `127.0.0.1:3001` and PostgreSQL on loopback, using a dedicated database and role. Public source code does not enable public signup or turn this app into a multi-user service.

## Configuration

Follow the README's database, model-credential, migration, and owner-creation steps. Set `BETTER_AUTH_URL` to your actual HTTPS origin before deployment. Keep `.env.local` and any sign-in notes outside version control, with mode 0600. Never put a database password, auth secret, model key, or owner password into the service template or documentation.

`infra/webcards.service` is an example systemd user unit. Replace `/srv/webcards` with the absolute path to your checkout and verify the Node.js binary path before installing a copy at `~/.config/systemd/user/webcards.service`. The template uses UTC, matching the app's default review-day timezone. A timezone settings UI is not configured.

Build the app before starting the service, reload the user units with `systemctl --user daemon-reload`, then enable and start the service with `systemctl --user enable --now webcards.service`. The unit restarts the app on failure. Configure lingering separately if it must start at boot without an interactive user session.

An example Caddy site, using a placeholder domain:

```caddyfile
webcards.example.com {
    reverse_proxy 127.0.0.1:3001
}
```

Use your own hostname, ensure its DNS and HTTPS certificate are valid, and validate Caddy's configuration before reloading it. Do not expose the app listener or PostgreSQL directly.

## Operations

- Check status: `systemctl --user status webcards.service`
- Restart: `systemctl --user restart webcards.service`
- Read recent logs: `journalctl --user -u webcards.service -n 100 --no-pager`
- App config: `.env.local` in the checkout (mode 0600; contains database, auth, and dedicated LiteLLM credentials)
- Local host-specific deployment notes: keep outside Git, for example in the ignored `.local/` directory.

For an application update, validate an isolated checkout first. Automated test suites use disposable databases and a fake model, not production data or model credentials. Do not run `next dev`, browser-test servers, or validation builds against the active deployment directory: replacing its `.next` output can break requests from the running process. For an in-place release, stop the app, install locked dependencies if changed, apply required migrations, build, and start it again; this causes a maintenance interruption. Keep configuration and credentials private. A live model smoke check requires separate authorization and is not a model-quality benchmark.

The installable app uses a manifest and home-screen icons, without a service worker or offline data cache. Open the HTTPS site in a supported browser and use its install or Add to Home Screen menu; see the README for platform-specific instructions. The installed app loads updates when it is reloaded or reopened, and still needs a connection for sign-in, translations, vocabulary, and reviews.

This setup does not add backup/restore automation, account export/deletion, offline model access, multi-instance support, or a provider privacy/terms review. Review upstream handling before entering sensitive text.
