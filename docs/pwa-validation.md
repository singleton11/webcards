# PWA validation

Webcards is an online-only installable app. The manifest specifies a stable root identity, standalone display, matching theme colors, regular 192px and 512px icons, and a maskable 512px icon. A 180px Apple touch icon and Apple web-app metadata support the iOS/iPadOS home-screen flow. The icon artwork stays within the maskable safe area.

Installation instructions appear on the login and authenticated screens. Chromium's optional install prompt is invoked only by a user gesture, consumed once, and falls back to browser-menu instructions if dismissed or unavailable. Safari gets platform-specific instructions. Installation UI is hidden in standalone mode. No service worker is registered, no private data is added to Cache Storage, and installation does not enable offline use or push notifications. Reloading or reopening loads the current hosted app.

## Checks

- `npm run typecheck`: passed.
- `npm test`: 86 unit/integration tests passed, including manifest and PNG-dimension checks.
- `npm run build`: passed.
- `npm run test:browser`: 31 Chromium scenarios passed, including install UI at 390px and 1365px, keyboard access, simulated iPhone/iPad instructions, simulated prompt acceptance/dismissal/failure, standalone mode, form preservation, sign-in protection, translation, vocabulary, and reviews. PostgreSQL and model responses were isolated test fixtures.
- `WEBCARDS_E2E_PRODUCTION=1 npm run test:browser -- --grep 'manifest and icons|install instructions|native installation|dismissing a one-use|failed native prompt|gets Safari|installation controls|installation event|installed-app assets'`: 12 PWA scenarios passed against a production build with isolated fixtures. Chromium reported no installability errors.
- After the explicitly approved restart, an unauthenticated Chromium check of the public HTTPS site returned no manifest or installability errors; all four PNG icons were served at their intended dimensions. The 390px login page had no horizontal overflow or browser script errors. The fresh browser context reported no service worker or Cache Storage entries.

The Chromium check does not perform an operating-system installation, and the Safari instructions were tested with emulated browser properties, not on a physical iPhone or iPad. No real model call was made as part of PWA validation. Existing provider privacy/terms and model-quality limitations remain unchanged.
