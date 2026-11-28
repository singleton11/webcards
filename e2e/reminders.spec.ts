import { createECDH } from "node:crypto";
import { expect, test } from "@playwright/test";

// The service worker fetch runs outside the page's certificate override.
test.use({
  launchOptions: {
    args:
      process.env.WEBCARDS_E2E_HTTPS === "1"
        ? ["--ignore-certificate-errors"]
        : [],
  },
});

test("Today saves and disables a reminder for this browser", async ({
  page,
  context,
}) => {
  const browser = createECDH("prime256v1");
  browser.generateKeys();
  const subscription = {
    endpoint: "https://fcm.googleapis.com/fcm/send/webcards-browser-test",
    keys: {
      p256dh: browser.getPublicKey().toString("base64url"),
      auth: Buffer.alloc(16, 1).toString("base64url"),
    },
  };
  await page.addInitScript((fixture) => {
    const current = { ...fixture, toJSON: () => fixture };
    const storageKey = "webcards-test-push";

    Object.defineProperties(PushManager.prototype, {
      getSubscription: {
        value: async () =>
          sessionStorage.getItem(storageKey) ? current : null,
      },
      subscribe: {
        value: async () => {
          sessionStorage.setItem(storageKey, "1");
          return current;
        },
      },
    });
  }, subscription);
  await context.grantPermissions(["notifications"]);
  const cdp = await context.newCDPSession(page);
  let registrationId: string | undefined;
  cdp.on("ServiceWorker.workerRegistrationUpdated", ({ registrations }) => {
    registrationId = registrations.find(
      (registration) => !registration.isDeleted,
    )?.registrationId;
  });
  await cdp.send("ServiceWorker.enable");
  await page.goto("/login");
  await page.getByLabel("Username").fill("owner");
  await page.getByLabel("Password").fill("isolated-password-1234");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL("/");
  await page.goto("/today");
  await page.getByText("Evening reminder", { exact: true }).click();
  const time = page.getByLabel("Reminder time");
  await expect(time).toHaveValue("19:00");
  await time.fill("20:15");
  await page.getByRole("button", { name: "Enable reminder" }).click();
  await expect(
    page.getByRole("button", { name: "Turn off reminder" }),
  ).toBeVisible();
  await expect(
    page.getByText("Reminder is on for this browser."),
  ).toBeVisible();
  await expect.poll(() => registrationId).toBeDefined();
  const worker = context
    .serviceWorkers()
    .find((worker) => worker.url().endsWith("/reminder-worker.js"));
  expect(worker).toBeDefined();
  // Observe the worker call without depending on a desktop notification daemon.
  await worker!.evaluate(() => {
    Object.defineProperty(
      ServiceWorkerRegistration.prototype,
      "showNotification",
      {
        value: async (title: string) =>
          Reflect.set(globalThis, "testNotificationTitle", title),
      },
    );
  });
  await cdp.send("ServiceWorker.deliverPushMessage", {
    origin: new URL(page.url()).origin,
    registrationId: registrationId!,
    data: "review",
  });
  await expect
    .poll(() =>
      worker!.evaluate(() => Reflect.get(globalThis, "testNotificationTitle")),
    )
    .toBe("Time to review your words");
  await cdp.detach();
  await page.reload();
  await page.getByText("Evening reminder", { exact: true }).click();
  await expect(time).toHaveValue("20:15");
  await page.getByRole("button", { name: "Turn off reminder" }).click();
  await expect(
    page.getByRole("button", { name: "Enable reminder" }),
  ).toBeVisible();
});
