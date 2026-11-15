import { expect, test, type BrowserContext, type Page } from "@playwright/test";
let cookies: Awaited<ReturnType<BrowserContext["cookies"]>>;
test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel("Username").fill("owner");
  await page.getByLabel("Password").fill("isolated-password-1234");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/");
  cookies = await context.cookies();
  await context.close();
});
async function login(page: Page) {
  await page.context().addCookies(cookies);
  await page.goto("/");
  await expect(page).toHaveURL("/");
}
for (const viewport of [
  { width: 390, height: 844 },
  { width: 1365, height: 900 },
]) {
  test.describe(viewport.width + "px viewport", () => {
    test.use({ viewport });
    test("protected translation in both directions", async ({ page }) => {
      await login(page);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBeTruthy();
      await expect(
        page.getByText("Provider retention is not yet verified", {
          exact: false,
        }),
      ).toBeVisible();
      await expect(page.getByLabel("Source language")).toHaveValue("en");
      await expect(page.locator(".target-language")).toHaveText("Russian");
      const source = page.getByLabel("Text to translate");
      await expect(source).toHaveAttribute("lang", "en");
      await source.fill("good morning");
      await expect(page.locator("#character-count")).toHaveText("12 / 500");
      await page
        .getByRole("button", { name: "Translate", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "доброе утро" }),
      ).toBeVisible();
      await expect(
        page.getByText("Only the meaning you choose is saved.", {
          exact: true,
        }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Swap languages" }).click();
      await expect(page.getByLabel("Source language")).toHaveValue("ru");
      await expect(page.locator(".target-language")).toHaveText("English");
      await expect(source).toHaveValue("доброе утро");
      await page
        .getByRole("button", { name: "Translate", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "good morning" }),
      ).toBeVisible();
      await page.screenshot({
        path: "test-results/translator-" + viewport.width + ".png",
        fullPage: true,
      });
    });
  });
}
test("ambiguity asks for context, invalid login is visible, and navigation is honest", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByLabel("Username").fill("owner");
  await page.getByLabel("Password").fill("incorrect");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator(".login-form [role=alert]")).toContainText(
    "Sign-in failed",
  );
  await page.getByLabel("Password").fill("isolated-password-1234");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByLabel("Text to translate")).toBeVisible();
  await page.getByLabel("Source language").selectOption("en");
  await page.getByLabel("Text to translate").fill("bank");
  await expect(page.locator("#character-count")).toHaveText("4 / 500");
  await page.getByRole("button", { name: "Translate", exact: true }).click();
  await expect(
    page.getByText("A financial institution or a river bank?"),
  ).toBeVisible();
  await page.getByLabel("A little context").fill("finance");
  await page.getByRole("button", { name: "Translate", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "доброе утро" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "My list" }).click();
  await expect(page.getByLabel("Search vocabulary")).toBeVisible();
  await page.getByRole("link", { name: "Today", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Today's progress" }),
  ).toBeVisible();
});
test("preserves input and request identity across a failed connection", async ({
  page,
}) => {
  await login(page);
  const ids: string[] = [];
  await page.route("**/api/translate", async (route) => {
    ids.push(route.request().postDataJSON().requestId);
    if (ids.length === 1) await route.abort("failed");
    else await route.continue();
  });
  await page.getByLabel("Source language").selectOption("ru");
  const text = page.getByLabel("Text to translate");
  await text.fill("Привет");
  await expect(page.locator("#character-count")).toHaveText("6 / 500");
  expect(ids).toHaveLength(0);
  await text.press("Control+Enter");
  await expect(
    page.getByText("Connection interrupted", { exact: false }),
  ).toBeVisible();
  await expect(text).toHaveValue("Привет");
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "good morning" }),
  ).toBeVisible();
  expect(ids).toHaveLength(2);
  expect(ids[0]).toBe(ids[1]);
  await text.fill("Привет!");
  await expect(page.locator("#character-count")).toHaveText("7 / 500");
  await page.getByRole("button", { name: "Translate", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "good morning" }),
  ).toBeVisible();
  expect(ids).toHaveLength(3);
  expect(ids[2]).not.toBe(ids[0]);
});
test("sign-out revokes access to protected navigation", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/login/);
  await page.goto("/");
  await expect(page).toHaveURL(/login/);
});
test("unauthenticated and untrusted-origin requests cannot submit text", async ({
  request,
}) => {
  const payload = {
    requestId: crypto.randomUUID(),
    source: "en",
    target: "ru",
    text: "hello",
    context: "",
  };
  expect(
    (
      await request.post("/api/translate", {
        headers: {
          origin:
            process.env.WEBCARDS_E2E_HTTPS === "1"
              ? "https://127.0.0.1:33117"
              : "http://127.0.0.1:33117",
        },
        data: payload,
      })
    ).status(),
  ).toBe(401);
  expect(
    (
      await request.post("/api/translate", {
        headers: { origin: "https://evil.test" },
        data: payload,
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await request.post("/api/auth/sign-in/username", {
        headers: { origin: "https://evil.test" },
        data: { username: "owner", password: "isolated-password-1234" },
      })
    ).status(),
  ).toBe(403);
});
