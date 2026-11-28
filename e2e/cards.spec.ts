import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const origin =
  process.env.WEBCARDS_E2E_HTTPS === "1"
    ? "https://127.0.0.1:33117"
    : "http://127.0.0.1:33117";
let cookies: Awaited<ReturnType<BrowserContext["cookies"]>>;
let secondDeviceCookies: Awaited<ReturnType<BrowserContext["cookies"]>>;
async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Username").fill("owner");
  await page.getByLabel("Password").fill("isolated-password-1234");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/");
}
async function translate(
  page: Page,
  text = "доброе утро",
  context = "morning at home",
) {
  await page.goto("/");
  await page.getByLabel("Source language").selectOption("ru");
  await page.getByLabel("Text to translate").fill(text);
  await page.getByLabel("A little context").fill(context);
  await page.getByRole("button", { name: "Translate", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Add to my list" }).first(),
  ).toBeVisible();
}
async function assertNoOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
}
async function savedCard(page: Page) {
  const response = await page.request.get("/api/cards");
  const body = await response.json();
  expect(body.total).toBe(1);
  return body.cards[0];
}
test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page);
  cookies = await context.cookies();
  await context.close();
  const secondDevice = await browser.newContext();
  await signIn(await secondDevice.newPage());
  secondDeviceCookies = await secondDevice.cookies();
  await secondDevice.close();
});
test.beforeEach(async ({ context, page }) => {
  await context.addCookies(cookies);
  for (const status of ["active", "archived"]) {
    const response = await page.request.get("/api/cards?status=" + status);
    const body = await response.json();
    for (const card of body.cards) {
      const deleted = await page.request.post("/api/cards/" + card.id, {
        headers: { origin },
        data: {
          action: "delete",
          requestId: crypto.randomUUID(),
          revision: card.revision,
        },
      });
      expect(deleted.ok()).toBeTruthy();
    }
  }
});
for (const viewport of [
  { width: 390, height: 844 },
  { width: 1365, height: 900 },
]) {
  test.describe(viewport.width + "px vocabulary", () => {
    test.use({ viewport });
    test("translate, save, reverse-deduplicate, search, version, archive, restore and delete", async ({
      page,
    }) => {
      await page.goto("/list");
      await expect(
        page.getByRole("heading", { name: "Your first keeper awaits." }),
      ).toBeVisible();
      await translate(page);
      expect((await (await page.request.get("/api/cards")).json()).total).toBe(
        0,
      );
      await page.getByRole("button", { name: "Add to my list" }).click();
      await expect(page.locator(".saved-row [role=status]")).toHaveText(
        "Saved",
      );
      const first = await savedCard(page);
      expect(first.content).toMatchObject({
        russian: "доброе утро",
        english: "good morning",
        context: "morning at home",
      });
      await page.getByRole("button", { name: "Swap languages" }).click();
      await page
        .getByRole("button", { name: "Translate", exact: true })
        .click();
      await page.getByRole("button", { name: "Add to my list" }).click();
      await expect(
        page.getByText("Already saved", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Undo", exact: true }),
      ).toHaveCount(0);
      expect((await savedCard(page)).id).toBe(first.id);
      await page.getByRole("link", { name: "My list", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "good morning" }),
      ).toBeVisible();
      await page.getByLabel("Search vocabulary").fill("ДОБРОЕ");
      await page.getByRole("button", { name: "Search", exact: true }).click();
      await expect(page.getByRole("status")).toContainText(
        "1 active card matching your search",
      );
      await assertNoOverflow(page);
      await expect(page.locator(".vocabulary-grid")).toHaveCSS("opacity", "1");
      await page.screenshot({
        path: "test-results/list-" + viewport.width + ".png",
        fullPage: true,
      });
      await page.getByRole("link", { name: /^Manage / }).click();
      await expect(page).toHaveURL(new RegExp("/list/[0-9a-f-]+$"));
      await expect(
        page.getByRole("heading", { name: "good morning", exact: true }),
      ).toBeVisible();
      await page.reload();
      await expect(
        page.getByText("morning at home", { exact: true }),
      ).toBeVisible();
      await assertNoOverflow(page);
      await page.screenshot({
        path: "test-results/card-" + viewport.width + ".png",
        fullPage: true,
      });
      await page
        .getByRole("button", { name: "Edit card", exact: true })
        .click();
      await page.getByLabel("English side").fill("a very good morning");
      await page
        .getByLabel("Context", { exact: false })
        .fill("a warm greeting at home");
      await assertNoOverflow(page);
      await page.screenshot({
        path: "test-results/editor-" + viewport.width + ".png",
        fullPage: true,
      });
      await page
        .getByRole("button", { name: "Save changes", exact: true })
        .click();
      await expect(page.getByRole("status")).toHaveText("Changes saved.");
      expect((await savedCard(page)).version).toBe(2);
      await page
        .getByRole("button", { name: "Archive card", exact: true })
        .click();
      await expect(page.getByRole("status")).toHaveText("Card archived.");
      await page.getByRole("link", { name: "Back to My list" }).click();
      await expect(page.getByRole("status")).toHaveText("0 active cards");
      await page.getByRole("button", { name: "Archived", exact: true }).click();
      await expect(page.getByRole("status")).toHaveText("1 archived card");
      await page.getByRole("link", { name: /^Manage / }).click();
      await expect(page).toHaveURL(new RegExp("/list/[0-9a-f-]+$"));
      await page
        .getByRole("button", { name: "Restore card", exact: true })
        .click();
      await expect(page.getByRole("status")).toHaveText("Card restored.");
      await page
        .getByRole("button", { name: "Delete card", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Keep card", exact: true })
        .click();
      expect((await savedCard(page)).version).toBe(2);
      await page
        .getByRole("button", { name: "Delete card", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Delete permanently", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "Card deleted." }),
      ).toBeVisible();
      expect((await page.request.get("/api/cards/" + first.id)).status()).toBe(
        404,
      );
    });
  });
}
test("saves only the selected alternative, not unrelated meanings", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await translate(page, "лук", "");
  await expect(
    page.getByRole("heading", { name: "onion", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "bow", exact: true }),
  ).toBeVisible();
  await page
    .locator(".translation-alternative")
    .nth(1)
    .getByRole("button", { name: "Add to my list" })
    .click();
  await expect(page.locator(".saved-row [role=status]")).toHaveText("Saved");
  const card = await savedCard(page);
  expect(card.content).toMatchObject({
    russian: "лук",
    english: "bow",
    sense: "archery weapon",
    context: "",
  });
  await page.getByRole("link", { name: "My list", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "bow", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "onion", exact: true }),
  ).toHaveCount(0);
});
test("save and undo survive lost responses after database commits", async ({
  page,
}) => {
  await translate(page);
  const saveIds: string[] = [],
    undoIds: string[] = [];
  await page.route("**/api/cards", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    saveIds.push(route.request().postDataJSON().requestId);
    if (saveIds.length === 1) {
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Add to my list" }).click();
  await expect(page.locator(".save-error")).toContainText("could not confirm");
  await expect(page.locator(".saved-row")).toHaveCount(0);
  await page.getByRole("button", { name: "Add to my list" }).click();
  await expect(page.locator(".saved-row [role=status]")).toHaveText("Saved");
  expect(saveIds).toHaveLength(2);
  expect(saveIds[0]).toBe(saveIds[1]);
  const first = await savedCard(page);
  await page.route("**/api/cards/*", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    undoIds.push(route.request().postDataJSON().requestId);
    if (undoIds.length === 1) {
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.locator(".save-error")).toContainText("could not confirm");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByText("Save undone.", { exact: false })).toBeVisible();
  expect(undoIds).toHaveLength(2);
  expect(undoIds[0]).toBe(undoIds[1]);
  expect((await (await page.request.get("/api/cards")).json()).total).toBe(0);
  await page.getByRole("button", { name: "Add to my list" }).click();
  await expect(page.locator(".saved-row [role=status]")).toHaveText("Saved");
  expect(saveIds[2]).not.toBe(saveIds[0]);
  expect((await savedCard(page)).id).not.toBe(first.id);
});
test("two tabs cannot overwrite content; stale edits remain visible for recovery", async ({
  page,
  context,
}) => {
  await translate(page);
  await page.getByRole("button", { name: "Add to my list" }).click();
  await page.getByRole("link", { name: "View card" }).click();
  await expect(page).toHaveURL(new RegExp("/list/[0-9a-f-]+$"));
  const other = await context.newPage();
  await other.goto(page.url());
  await expect(
    other.getByRole("button", { name: "Edit card", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit card", exact: true }).click();
  await other.getByRole("button", { name: "Edit card", exact: true }).click();
  await page.getByLabel("English side").fill("first tab answer");
  await other.getByLabel("English side").fill("second tab answer");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Changes saved.");
  await other
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(other.locator(".card-page .error-banner")).toContainText(
    "changed in another tab or device",
  );
  await expect(other.getByLabel("English side")).toHaveValue(
    "second tab answer",
  );
  expect((await savedCard(page)).content.english).toBe("first tab answer");
  await other
    .getByRole("button", { name: "Reload current card", exact: false })
    .click();
  await expect(
    other.getByRole("heading", { name: "first tab answer", exact: true }),
  ).toBeVisible();
  await other.close();
});
test("a separate account gets its own private vocabulary", async ({
  page,
  browser,
}) => {
  await translate(page);
  await page.getByRole("button", { name: "Add to my list" }).click();
  await expect(page.locator(".saved-row [role=status]")).toHaveText("Saved");
  const secondContext = await browser.newContext();
  const secondPage = await secondContext.newPage();
  await secondPage.goto("/login");
  await secondPage.getByLabel("Username").fill("second");
  await secondPage.getByLabel("Password").fill("isolated-password-1234");
  await secondPage.getByRole("button", { name: "Sign in" }).click();
  await expect(secondPage).toHaveURL("/");
  expect(
    (await (await secondPage.request.get("/api/cards")).json()).total,
  ).toBe(0);
  await secondContext.close();
});

test("a separate browser sign-in sees saved vocabulary and logout protects it", async ({
  page,
  browser,
}) => {
  await translate(page);
  await page.getByRole("button", { name: "Add to my list" }).click();
  await expect(page.locator(".saved-row [role=status]")).toHaveText("Saved");
  const card = await savedCard(page);
  const secondContext = await browser.newContext();
  try {
    await secondContext.addCookies(secondDeviceCookies);
    const second = await secondContext.newPage();
    await second.goto("/list/" + card.id);
    await second.getByRole("link", { name: "My list", exact: true }).click();
    await expect(
      second.getByRole("heading", { name: "good morning", exact: true }),
    ).toBeVisible();
    await second.getByRole("button", { name: "Sign out" }).click();
    await expect(second).toHaveURL(/login/);
    expect((await second.request.get("/api/cards")).status()).toBe(401);
    expect((await second.request.get("/api/cards/" + card.id)).status()).toBe(
      401,
    );
  } finally {
    await secondContext.close();
  }
});
test("empty search and interrupted list loading give honest recoverable states", async ({
  page,
}) => {
  await translate(page);
  await page.getByRole("button", { name: "Add to my list" }).click();
  await expect(page.locator(".saved-row [role=status]")).toHaveText("Saved");
  await page.route("**/api/cards?**", (route) => route.abort("failed"));
  await page.goto("/list");
  await expect(page.locator(".vocabulary-page .error-banner")).toContainText(
    "Connection interrupted",
  );
  await page.unroute("**/api/cards?**");
  await page.getByRole("button", { name: "Retry loading" }).click();
  await expect(
    page.getByRole("heading", { name: "good morning", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Search vocabulary").fill("no-such-word");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "No matching meanings." }),
  ).toBeVisible();
  await page.getByLabel("Search vocabulary").fill("home");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "good morning", exact: true }),
  ).toBeVisible();
});

test("asks before saving the same translation with different context", async ({
  page,
}) => {
  await translate(page);
  await page.getByRole("button", { name: "Add to my list" }).click();
  await expect(page.locator(".saved-row [role=status]")).toHaveText("Saved");
  const first = await savedCard(page);

  await translate(page, "доброе утро", "greeting a coworker");
  await page.getByRole("button", { name: "Add to my list" }).click();
  await expect(page.getByText("Similar card already saved")).toBeVisible();
  await expect(
    page.getByText("morning at home", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "View saved card" }),
  ).toHaveAttribute("href", "/list/" + first.id);
  expect((await savedCard(page)).id).toBe(first.id);

  await page.getByRole("button", { name: "Keep both" }).click();
  await expect(page.locator(".saved-row [role=status]")).toHaveText("Saved");
  const { total } = await (await page.request.get("/api/cards")).json();
  expect(total).toBe(2);
});
