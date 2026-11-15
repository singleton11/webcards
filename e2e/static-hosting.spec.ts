import { expect, test } from "@playwright/test";

test("Caddy serves only built assets and sends API requests to the private backend", async ({
  request,
}) => {
  const html = await request.get("/list/00000000-0000-4000-8000-000000000000");
  expect(html.status()).toBe(200);
  expect(html.headers()["cache-control"]).toContain("no-store");
  expect(html.headers()["x-frame-options"]).toBe("DENY");
  expect(html.headers()["x-content-type-options"]).toBe("nosniff");
  const body = await html.text();
  expect(body).toContain('<div id="root"></div>');
  expect(body).not.toContain("isolated-test-secret-not-for-deployment");
  const asset = body.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
  expect(asset).toBeTruthy();
  const js = await request.get(asset!);
  expect(js.status()).toBe(200);
  expect(js.headers()["cache-control"]).toContain("immutable");
  expect(await js.text()).not.toContain(
    "isolated-test-secret-not-for-deployment",
  );
  expect((await request.get("/assets/missing.js")).status()).toBe(404);
  expect((await request.get("/icons/missing.png")).status()).toBe(404);
  const api = await request.get("/api/not-a-route");
  expect(api.status()).toBe(404);
  expect(api.headers()["content-type"]).toContain("application/json");
  expect(api.headers()["cache-control"]).toContain("no-store");
  expect((await request.put("/api/cards")).status()).toBe(405);
  const oversize = await request.post("/api/auth/sign-in/username", {
    headers: {
      origin: "http://127.0.0.1:33117",
      "content-type": "application/json",
    },
    data: JSON.stringify({ username: "x".repeat(20000), password: "x" }),
  });
  expect(oversize.status()).toBe(413);
});

test("session outages are recoverable and protected pages do not reveal data", async ({
  page,
}) => {
  await page.route("**/api/session", (route) => route.abort());
  await page.goto("/today");
  await expect(page.getByRole("alert")).toContainText(
    "session could not be checked",
  );
  await expect(
    page.getByRole("region", { name: "Today's progress" }),
  ).toHaveCount(0);
  await page.unroute("**/api/session");
  await page.getByRole("button", { name: "Retry connection" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});

test("missing or inaccessible cards do not expose another account's data", async ({
  page,
  request,
}) => {
  const origin =
    process.env.WEBCARDS_E2E_HTTPS === "1"
      ? "https://127.0.0.1:33117"
      : "http://127.0.0.1:33117";
  expect(
    (
      await request.post("/api/auth/sign-in/username", {
        headers: { origin },
        data: { username: "owner", password: "isolated-password-1234" },
      })
    ).ok(),
  ).toBe(true);
  const saved = await request.post("/api/cards", {
    headers: { origin },
    data: {
      requestId: crypto.randomUUID(),
      source: "en",
      model: "chatgpt-gpt-6-luna",
      promptVersion: "translate-v1",
      content: {
        russian: "река",
        english: "private test river",
        sense: "watercourse",
        context: "",
        note: "",
      },
    },
  });
  expect(saved.ok()).toBe(true);
  const card = (await saved.json()).card;
  await page.goto("/login");
  await page.getByLabel("Username").fill("second");
  await page.getByLabel("Password").fill("isolated-password-1234");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/");
  await page.goto("/list/" + card.id);
  await expect(
    page.getByRole("heading", { name: "Page not found." }),
  ).toBeVisible();
  await expect(page.getByText("private test river")).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Page not found." }),
  ).toBeVisible();
  expect((await page.request.get("/api/cards/" + card.id)).status()).toBe(404);
});
