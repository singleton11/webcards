import { expect, test } from "@playwright/test";

test("HTTPS Caddy forwards sign-in and secure sessions without trusting other origins", async ({
  page,
  request,
}) => {
  test.skip(
    process.env.WEBCARDS_E2E_HTTPS !== "1",
    "Run with WEBCARDS_E2E_HTTPS=1",
  );
  await page.goto("/login");
  await page.getByLabel("Username").fill("owner");
  await page.getByLabel("Password").fill("isolated-password-1234");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByLabel("Text to translate")).toBeVisible();
  const cookies = await page.context().cookies();
  expect(
    cookies.some(
      (cookie) =>
        cookie.name.includes("session_token") &&
        cookie.secure &&
        cookie.httpOnly,
    ),
  ).toBe(true);
  await page.reload();
  await expect(page.getByLabel("Text to translate")).toBeVisible();
  const response = await request.post("/api/auth/sign-in/username", {
    headers: { origin: "https://evil.example" },
    data: { username: "owner", password: "isolated-password-1234" },
  });
  expect(response.status()).toBe(403);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
});
