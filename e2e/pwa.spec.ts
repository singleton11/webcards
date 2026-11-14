import { expect, test, type Page } from "@playwright/test";

async function installPanel(page: Page) {
  const panel = page.getByRole("complementary", { name: "App installation" });
  await expect(panel).toBeVisible();
  await panel.locator("summary").click();
  return panel;
}

async function offerInstall(
  page: Page,
  outcome: "accepted" | "dismissed" | "error",
) {
  return page.evaluate((result) => {
    Reflect.set(window, "installCalls", 0);
    const event = new Event("beforeinstallprompt", { cancelable: true });
    Object.assign(event, {
      prompt: async () => {
        Reflect.set(
          window,
          "installCalls",
          Reflect.get(window, "installCalls") + 1,
        );
        if (result === "error") throw new Error("Fixture prompt failure");
      },
      userChoice: Promise.resolve({ outcome: result }),
    });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  }, outcome);
}

test("manifest and icons are public, with no Chromium installability errors", async ({
  page,
  request,
}) => {
  await page.goto("/login");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    "href",
    "/manifest.webmanifest",
  );
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
    "content",
    "#183e34",
  );
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute(
    "content",
    /viewport-fit=cover/,
  );
  await expect(page.locator('meta[name="viewport"]')).not.toHaveAttribute(
    "content",
    /user-scalable=no|maximum-scale=1/,
  );
  await expect(
    page.locator('meta[name="apple-mobile-web-app-title"]'),
  ).toHaveAttribute("content", "Webcards");
  const appleIcon = await request.get("/icons/apple-touch-icon.png");
  expect(appleIcon.status()).toBe(200);
  expect(appleIcon.headers()["content-type"]).toContain("image/png");

  const response = await request.get("/manifest.webmanifest");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain(
    "application/manifest+json",
  );
  const manifest = await response.json();
  expect(manifest).toMatchObject({
    id: "/",
    scope: "/",
    start_url: "/",
    display: "standalone",
  });
  for (const icon of manifest.icons) {
    const iconResponse = await request.get(icon.src);
    expect(iconResponse.status()).toBe(200);
    expect(iconResponse.headers()["content-type"]).toContain("image/png");
  }

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Page.enable");
  const appManifest = await cdp.send("Page.getAppManifest");
  expect(appManifest.errors).toEqual([]);
  expect(JSON.parse(appManifest.data!)).toMatchObject(manifest);
  await expect
    .poll(
      async () =>
        (await cdp.send("Page.getInstallabilityErrors")).installabilityErrors,
    )
    .toEqual([]);
  await cdp.detach();
});

for (const width of [390, 1365]) {
  test(`install instructions fit a ${width}px screen and support keyboard access`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/login");
    const panel = page.getByRole("complementary", { name: "App installation" });
    await expect(panel).toBeVisible();
    await panel.locator("summary").focus();
    await page.keyboard.press("Enter");
    await expect(
      panel.getByText("Internet required", { exact: false }),
    ).toBeVisible();
    await expect(
      panel.getByText("no reinstall needed", { exact: false }),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Install app", exact: true }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/install-${width}.png`,
      fullPage: true,
    });
  });
}

test("native installation is offered only after browser eligibility and a user click", async ({
  page,
}) => {
  await page.goto("/login");
  const panel = await installPanel(page);
  expect(await offerInstall(page, "accepted")).toBe(true);
  await expect(
    panel.getByRole("button", { name: "Install app", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, "installCalls"))).toBe(
    0,
  );
  await panel.getByRole("button", { name: "Install app", exact: true }).click();
  await expect(panel).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.get(window, "installCalls"))).toBe(
    1,
  );
});

test("dismissing a one-use native prompt leaves manual instructions and accepts a fresh prompt", async ({
  page,
}) => {
  await page.goto("/login");
  const panel = await installPanel(page);
  await offerInstall(page, "dismissed");
  await panel.getByRole("button", { name: "Install app", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "Install app", exact: true }),
  ).toHaveCount(0);
  await expect(
    panel.getByText("address-bar install icon", { exact: false }),
  ).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, "installCalls"))).toBe(
    1,
  );
  await offerInstall(page, "accepted");
  await panel.getByRole("button", { name: "Install app", exact: true }).click();
  await expect(panel).toHaveCount(0);
});

test("a failed native prompt falls back to instructions without an unhandled error", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/login");
  const panel = await installPanel(page);
  await offerInstall(page, "error");
  await panel.getByRole("button", { name: "Install app", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText(
    "Use your browser's install menu",
  );
  await expect(
    panel.getByRole("button", { name: "Install app", exact: true }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});

for (const device of ["iPhone", "iPad desktop mode"]) {
  test(`${device} gets Safari home-screen guidance rather than a dead install button`, async ({
    page,
  }) => {
    await page.addInitScript((deviceName) => {
      if (deviceName === "iPhone") {
        Object.defineProperty(navigator, "userAgent", {
          value:
            "Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1",
        });
      } else {
        Object.defineProperty(navigator, "platform", { value: "MacIntel" });
        Object.defineProperty(navigator, "maxTouchPoints", { value: 5 });
      }
    }, device);
    await page.goto("/login");
    const panel = await installPanel(page);
    await expect(
      panel.getByText("tap Share, then Add to Home Screen", { exact: false }),
    ).toBeVisible();
    await expect(panel.getByRole("button")).toHaveCount(0);
  });
}

for (const mode of ["standalone", "ios standalone"]) {
  test(`installation controls stay hidden in ${mode} mode`, async ({
    page,
  }) => {
    await page.addInitScript((displayMode) => {
      if (displayMode === "ios standalone") {
        Object.defineProperty(navigator, "standalone", { value: true });
      } else {
        const matchMedia = window.matchMedia.bind(window);
        window.matchMedia = (query) => {
          const result = matchMedia(query);
          if (query.includes("display-mode: standalone")) {
            Object.defineProperty(result, "matches", { value: true });
          }
          return result;
        };
      }
    }, mode);
    await page.goto("/login");
    await expect(
      page.getByRole("button", { name: "Sign in", exact: true }),
    ).toBeVisible();
    // Wait for hydration before asserting absence of this client-only control.
    await page.getByLabel("Username").fill("owner");
    await page.getByLabel("Password").fill("incorrect");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.locator(".login-form [role=alert]")).toContainText(
      "Sign-in failed",
    );
    await expect(
      page.getByRole("complementary", { name: "App installation" }),
    ).toHaveCount(0);
  });
}

test("an installation event does not reload or discard the current form", async ({
  page,
}) => {
  await page.goto("/login");
  const panel = await installPanel(page);
  await page.getByLabel("Username").fill("unsaved draft");
  await page.evaluate(() => window.dispatchEvent(new Event("appinstalled")));
  await expect(panel).toHaveCount(0);
  await expect(page.getByLabel("Username")).toHaveValue("unsaved draft");
});

test("installed-app assets do not change authentication or cache private requests", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("Username").fill("owner");
  await page.getByLabel("Password").fill("isolated-password-1234");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL("/");
  const panel = await installPanel(page);
  await expect(
    panel.getByText("Internet required", { exact: false }),
  ).toBeVisible();
  await page.getByLabel("Text to translate").fill("hello");
  const response = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/translate") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Translate", exact: true }).click();
  expect((await response).headers()["cache-control"]).toContain("no-store");
  await expect(page.locator(".translation-alternative")).toBeVisible();
  expect(
    await page.evaluate(async () => ({
      caches: await caches.keys(),
      workers: (await navigator.serviceWorker.getRegistrations()).length,
    })),
  ).toEqual({ caches: [], workers: 0 });
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/today");
  await expect(page).toHaveURL(/\/login$/);
});
