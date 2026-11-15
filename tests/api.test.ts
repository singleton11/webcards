import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../src/api";

const handlers = vi.hoisted(() => ({
  session: vi.fn(),
  auth: vi.fn(),
  cards: vi.fn(),
  reviews: vi.fn(),
  translate: vi.fn(),
}));
vi.mock("../src/lib/auth", () => ({ ownerSession: handlers.session }));
vi.mock("../src/lib/auth-handler", () => ({
  handleAuthRequest: handlers.auth,
}));
vi.mock("../src/lib/card-api", () => ({ handleCardRequest: handlers.cards }));
vi.mock("../src/lib/review-api", () => ({
  handleReviewRequest: handlers.reviews,
}));
vi.mock("../src/lib/translation-api", () => ({
  handleTranslationRequest: handlers.translate,
}));

beforeEach(() => {
  vi.resetAllMocks();
  handlers.session.mockResolvedValue(null);
  for (const handler of [
    handlers.auth,
    handlers.cards,
    handlers.reviews,
    handlers.translate,
  ])
    handler.mockImplementation(async () => Response.json({ ok: true }));
});

describe("standalone API routing", () => {
  it("checks provisioned sessions without returning private session contents", async () => {
    const app = createApi();
    expect(await (await app.request("/api/session")).json()).toEqual({
      authenticated: false,
    });
    handlers.session.mockResolvedValue({
      user: { id: "private-id" },
      session: { token: "secret" },
    });
    const response = await app.request("/api/session", {
      headers: { cookie: "session=test" },
    });
    expect(await response.json()).toEqual({ authenticated: true });
    expect(handlers.session.mock.calls[1][0].get("cookie")).toBe(
      "session=test",
    );
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it.each([
    ["GET", "/api/cards", "cards"],
    ["POST", "/api/cards", "cards"],
    ["GET", "/api/reviews", "reviews"],
    ["POST", "/api/reviews", "reviews"],
    ["POST", "/api/translate", "translate"],
    ["GET", "/api/auth/get-session", "auth"],
    ["POST", "/api/auth/sign-out", "auth"],
  ] as const)(
    "routes %s %s to the existing service",
    async (method, path, handler) => {
      const response = await createApi().request(path, { method });
      expect(response.status).toBe(200);
      expect(handlers[handler]).toHaveBeenCalledOnce();
    },
  );

  it("preserves Unicode JSON and card identifiers", async () => {
    const id = crypto.randomUUID();
    const text = JSON.stringify({ answer: "берег" });
    handlers.cards.mockImplementation(
      async (request: Request, cardId: string) =>
        Response.json({ cardId, body: await request.text() }),
    );
    const response = await createApi().request("/api/cards/" + id, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: text,
    });
    expect(await response.json()).toEqual({ cardId: id, body: text });
  });

  it("rejects oversized auth bodies before invoking authentication", async () => {
    const response = await createApi().request("/api/auth/sign-in/username", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "x".repeat(20000) }),
    });
    expect(response.status).toBe(413);
    expect(handlers.auth).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("never falls back to frontend HTML for missing APIs or unsupported methods", async () => {
    const app = createApi();
    expect((await app.request("/api/missing")).status).toBe(404);
    expect((await app.request("/")).status).toBe(404);
    expect((await app.request("/api/cards", { method: "DELETE" })).status).toBe(
      405,
    );
    expect((await app.request("/api/translate")).status).toBe(405);
    expect(handlers.cards).not.toHaveBeenCalled();
    expect(handlers.translate).not.toHaveBeenCalled();
  });

  it("fails closed without leaking internal exception details", async () => {
    handlers.session.mockRejectedValue(
      new Error("postgresql://private-database-secret"),
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await createApi().request("/api/session");
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain("private-database-secret");
      expect(response.headers.get("cache-control")).toContain("no-store");
    } finally {
      log.mockRestore();
    }
  });
});
