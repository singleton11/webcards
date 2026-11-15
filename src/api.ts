import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ownerSession } from "./lib/auth";
import { handleAuthRequest } from "./lib/auth-handler";
import { handleCardRequest } from "./lib/card-api";
import { handleReviewRequest } from "./lib/review-api";
import { handleTranslationRequest } from "./lib/translation-api";

export function createApi() {
  const app = new Hono();
  app.use("*", async (context, next) => {
    await next();
    context.header("Cache-Control", "private, no-store");
    context.header("X-Content-Type-Options", "nosniff");
    context.header("Referrer-Policy", "same-origin");
    context.header("X-Frame-Options", "DENY");
    context.header(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()",
    );
  });
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: 16384,
      onError: (context) =>
        context.json({ error: "Request is too large." }, 413),
    }),
  );
  app.get("/api/session", async (context) =>
    context.json({
      authenticated: !!(await ownerSession(context.req.raw.headers)),
    }),
  );
  app.on(["GET", "POST"], "/api/auth/*", (context) =>
    handleAuthRequest(context.req.raw),
  );
  app.on(["GET", "POST"], "/api/cards", (context) =>
    handleCardRequest(context.req.raw),
  );
  app.on(["GET", "POST"], "/api/cards/:id", (context) =>
    handleCardRequest(context.req.raw, context.req.param("id")),
  );
  app.on(["GET", "POST"], "/api/reviews", (context) =>
    handleReviewRequest(context.req.raw),
  );
  app.post("/api/translate", (context) =>
    handleTranslationRequest(context.req.raw),
  );
  app.all("/api/session", (context) =>
    context.json({ error: "Method not allowed." }, 405),
  );
  app.all("/api/translate", (context) =>
    context.json({ error: "Method not allowed." }, 405),
  );
  app.all("/api/cards", (context) =>
    context.json({ error: "Method not allowed." }, 405),
  );
  app.all("/api/cards/:id", (context) =>
    context.json({ error: "Method not allowed." }, 405),
  );
  app.all("/api/reviews", (context) =>
    context.json({ error: "Method not allowed." }, 405),
  );
  app.all("/api/auth/*", (context) =>
    context.json({ error: "Method not allowed." }, 405),
  );
  app.notFound((context) => context.json({ error: "Not found." }, 404));
  app.onError((_error, context) => {
    console.error(JSON.stringify({ event: "api_error", category: "internal" }));
    return context.json(
      { error: "Webcards is temporarily unavailable. Please retry." },
      503,
    );
  });
  return app;
}
