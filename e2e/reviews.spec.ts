import { expect, test, type BrowserContext, type Page } from "@playwright/test";
const origin = "http://127.0.0.1:33117";
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
test.beforeEach(async ({ context, page }) => {
  await context.addCookies(cookies);
  for (const status of ["active", "archived"]) {
    const list = await (
      await page.request.get("/api/cards?status=" + status)
    ).json();
    for (const card of list.cards) {
      expect(
        (
          await page.request.post("/api/cards/" + card.id, {
            headers: { origin },
            data: {
              action: "delete",
              requestId: crypto.randomUUID(),
              revision: card.revision,
            },
          })
        ).ok(),
      ).toBe(true);
    }
  }
});
async function seed(page: Page) {
  const response = await page.request.post("/api/cards", {
    headers: { origin },
    data: {
      requestId: crypto.randomUUID(),
      source: "ru",
      model: "chatgpt-gpt-6-luna",
      promptVersion: "translate-v1",
      content: {
        russian: "берег",
        english: "bank",
        sense: "river edge",
        context: "by the river",
        note: "",
      },
    },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()).card;
}
async function start(page: Page) {
  await page.goto("/today");
  await page.getByRole("button", { name: "Start review" }).click();
  await expect(page.getByLabel("Your translation")).toBeVisible();
  return (await (await page.request.get("/api/reviews")).json()).session.item;
}
async function checkExact(
  page: Page,
  card: { content: { russian: string; english: string } },
) {
  const current = await (await page.request.get("/api/reviews")).json();
  await page
    .getByLabel("Your translation")
    .fill(
      current.session.item.direction === "ru-en"
        ? card.content.english
        : card.content.russian,
    );
  await page.getByRole("button", { name: "Check answer", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Saved answer" }),
  ).toBeVisible();
}
for (const viewport of [
  { width: 390, height: 844 },
  { width: 1365, height: 900 },
]) {
  test.describe(viewport.width + "px review", () => {
    test.use({ viewport });
    test("translate, save, review both directions, and resume a relearning session", async ({
      page,
    }) => {
      await page.goto("/");
      await page.getByLabel("Text to translate").fill("доброе утро");
      await page.getByLabel("A little context").fill("morning at home");
      await page
        .getByRole("button", { name: "Translate", exact: true })
        .click();
      await page.getByRole("button", { name: "Add to my list" }).click();
      await expect(page.locator(".saved-row [role=status]")).toHaveText(
        "Saved",
      );
      const card = (await (await page.request.get("/api/cards")).json())
        .cards[0];
      const first = await start(page);
      await checkExact(page, card);
      expect(
        (await (await page.request.get("/api/reviews")).json()).attempts,
      ).toBe(0);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: "test-results/review-feedback-" + viewport.width + ".png",
        fullPage: true,
      });
      await page.getByRole("button", { name: "Continue with result" }).click();
      await expect(page.getByText("A little breathing room.")).toBeVisible();
      let today = await (await page.request.get("/api/reviews")).json();
      expect(today).toMatchObject({
        completed: 1,
        attempts: 1,
        dueCards: 1,
        dueDirections: 1,
      });
      const sessionId = today.session.id;
      await page.reload();
      await expect(page.getByText("A little breathing room.")).toBeVisible();
      expect(
        (await (await page.request.get("/api/reviews")).json()).session.id,
      ).toBe(sessionId);
      await page
        .getByRole("button", {
          name: "End session without rating remaining questions",
        })
        .click();
      const second = await start(page);
      expect(second.direction).not.toBe(first.direction);
      await checkExact(page, card);
      await page.getByRole("button", { name: "Continue with result" }).click();
      await expect(page.getByText("A little breathing room.")).toBeVisible();
      today = await (await page.request.get("/api/reviews")).json();
      expect(today).toMatchObject({
        completed: 1,
        attempts: 2,
        dueDirections: 0,
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: "test-results/review-wait-" + viewport.width + ".png",
        fullPage: true,
      });
    });
  });
}
test("uncertain judgments and harmless typos require a recorded self-assessment", async ({
  page,
}) => {
  await seed(page);
  await start(page);
  await page.getByLabel("Your translation").fill("typpo");
  await page.getByRole("button", { name: "Check answer", exact: true }).click();
  await expect(
    page.getByText(
      "This needs your judgment; it will not update the schedule automatically.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Continue with result" }),
  ).toHaveCount(0);
  expect((await (await page.request.get("/api/reviews")).json()).attempts).toBe(
    0,
  );
  await page.getByRole("button", { name: "I recalled it" }).click();
  await expect(page.getByText("A little breathing room.")).toBeVisible();
  expect((await (await page.request.get("/api/reviews")).json()).attempts).toBe(
    1,
  );
});
test("an interrupted finalization retries the same attempt without double-counting", async ({
  page,
}) => {
  const card = await seed(page);
  await start(page);
  await checkExact(page, card);
  let interrupted = false;
  await page.route("**/api/reviews", async (route) => {
    if (
      route.request().method() === "POST" &&
      route.request().postDataJSON().action === "finalize" &&
      !interrupted
    ) {
      interrupted = true;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Continue with result" }).click();
  await expect(
    page.locator(".review-page .error-banner[role=alert]"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Continue with result" }).click();
  await expect(page.getByText("A little breathing room.")).toBeVisible();
  expect((await (await page.request.get("/api/reviews")).json()).attempts).toBe(
    1,
  );
});
test("a stale edit in another tab cannot finalize the old content", async ({
  page,
  context,
}) => {
  const card = await seed(page);
  const item = await start(page);
  await checkExact(page, card);
  const changed = await page.request.post("/api/cards/" + card.id, {
    headers: { origin },
    data: {
      action: "edit",
      requestId: crypto.randomUUID(),
      revision: card.revision,
      content: { ...card.content, english: "shore" },
    },
  });
  expect(changed.ok()).toBe(true);
  await page.getByRole("button", { name: "Continue with result" }).click();
  await expect(
    page.locator(".review-page .error-banner[role=alert]"),
  ).toContainText("This review changed");
  expect((await (await page.request.get("/api/reviews")).json()).attempts).toBe(
    0,
  );
  await page.getByRole("button", { name: "Refresh Today" }).click();
  await expect(
    page.getByRole("button", { name: "Start review" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Start review" }).click();
  await expect(page.getByLabel("Your translation")).toBeVisible();
  expect(
    (await (await page.request.get("/api/reviews")).json()).session.item.id,
  ).not.toBe(item.id);
  const second = await context.newPage();
  await second.goto("/today");
  await expect(second.getByLabel("Your translation")).toBeVisible();
  await second.close();
});
test("model outage preserves the typed answer and permits reveal/self-assessment without a penalty", async ({
  page,
}) => {
  await seed(page);
  await start(page);
  await page.route("**/api/reviews", async (route) => {
    if (
      route.request().method() === "POST" &&
      route.request().postDataJSON().action === "check"
    )
      await route.fulfill({
        status: 504,
        contentType: "application/json",
        body: JSON.stringify({
          error: "Grading timed out. No schedule changed.",
        }),
      });
    else await route.continue();
  });
  await page.getByLabel("Your translation").fill("a valid alternative");
  await page.getByRole("button", { name: "Check answer", exact: true }).click();
  await expect(
    page.locator(".review-page .error-banner[role=alert]"),
  ).toContainText("No schedule changed");
  await expect(page.getByLabel("Your translation")).toHaveValue(
    "a valid alternative",
  );
  expect((await (await page.request.get("/api/reviews")).json()).attempts).toBe(
    0,
  );
  await page.getByRole("button", { name: "Show answer" }).click();
  await expect(
    page.getByRole("heading", { name: "Saved answer" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Skip without rating" }).click();
  expect((await (await page.request.get("/api/reviews")).json()).attempts).toBe(
    0,
  );
});
