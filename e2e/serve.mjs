import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createSocketServer } from "node:net";
const root = mkdtempSync(join(tmpdir(), "webcards-browser-pg-"));
const data = join(root, "data"),
  pg = process.env.POSTGRES_BIN || "/usr/lib/postgresql/17/bin";
let started = false,
  next;
const mock = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (
    req.url !== "/v1/responses" ||
    req.method !== "POST" ||
    req.headers.authorization !== "Bearer fixture-only"
  ) {
    res.writeHead(400).end();
    return;
  }
  const request = JSON.parse(raw),
    input = JSON.parse(request.input[1].content);
  const payload =
    request.text?.format?.name === "grading"
      ? {
          verdict:
            input.answer === "typpo"
              ? "typo"
              : input.answer === "unclear"
                ? "needs_review"
                : input.answer === "shore"
                  ? "correct"
                  : "incorrect",
          reason: "Fixture judgment for the saved meaning.",
          correction: input.reference,
        }
      : input.text === "bank" && !input.context
        ? {
            status: "needs_context",
            alternatives: [],
            clarification: "A financial institution or a river bank?",
          }
        : input.text === "лук"
          ? {
              status: "ok",
              alternatives: [
                {
                  translation: "onion",
                  sense: "vegetable",
                  note: "Used in cooking.",
                },
                {
                  translation: "bow",
                  sense: "archery weapon",
                  note: "Used with arrows.",
                },
              ],
              clarification: null,
            }
          : {
              status: "ok",
              alternatives: [
                {
                  translation:
                    input.target === "en" ? "good morning" : "доброе утро",
                  sense: "greeting",
                  note: "A friendly greeting.",
                },
              ],
              clarification: null,
            };
  const completed = {
    type: "response.completed",
    response: {
      status: "completed",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: JSON.stringify(payload) }],
        },
      ],
      usage: { input_tokens: 20, output_tokens: 15 },
    },
  };
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end("data: " + JSON.stringify(completed) + "\n\ndata: [DONE]\n\n");
});
async function port() {
  const s = createSocketServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const n = s.address().port;
  await new Promise((r) => s.close(r));
  return n;
}
function shutdown() {
  if (next) next.kill("SIGTERM");
  mock.close();
  if (started) {
    try {
      execFileSync(
        join(pg, "pg_ctl"),
        ["-D", data, "-m", "immediate", "-w", "stop"],
        { stdio: "pipe", timeout: 8000 },
      );
    } catch (error) {
      console.error(
        "Could not stop disposable PostgreSQL; its data was retained at " +
          root,
        error,
      );
      return false;
    }
    started = false;
  }
  rmSync(root, { recursive: true, force: true });
  return true;
}
process.on("SIGINT", () => {
  process.exit(shutdown() ? 0 : 1);
});
process.on("SIGTERM", () => {
  process.exit(shutdown() ? 0 : 1);
});
try {
  const dbPort = await port(),
    modelPort = await port();
  execFileSync(
    join(pg, "initdb"),
    [
      "-D",
      data,
      "--auth=trust",
      "--username=webcards_test",
      "--no-locale",
      "--encoding=UTF8",
    ],
    { stdio: "ignore" },
  );
  execFileSync(
    join(pg, "pg_ctl"),
    [
      "-D",
      data,
      "-l",
      join(root, "postgres.log"),
      "-o",
      "-h 127.0.0.1 -p " + dbPort + " -k " + root,
      "-w",
      "start",
    ],
    { stdio: "ignore" },
  );
  started = true;
  await new Promise((resolve) => mock.listen(modelPort, "127.0.0.1", resolve));
  const env = {
    ...process.env,
    WEBCARDS_E2E_FIXTURE: "1",
    DATABASE_URL:
      "postgresql://webcards_test@127.0.0.1:" + dbPort + "/postgres",
    BETTER_AUTH_URL: "http://127.0.0.1:33117",
    BETTER_AUTH_SECRET: "isolated-test-secret-not-for-deployment-1234",
    OWNER_USERNAME: "owner",
    LITELLM_API_KEY: "fixture-only",
    LITELLM_MODEL: "chatgpt-gpt-6-luna",
    LITELLM_BASE_URL: "http://127.0.0.1:" + modelPort + "/v1",
    TRANSLATIONS_PER_DAY: "100",
  };
  execFileSync("./node_modules/.bin/tsx", ["e2e/setup-db.ts"], {
    env,
    stdio: "inherit",
  });
  next = spawn(
    "./node_modules/.bin/next",
    [
      process.env.WEBCARDS_E2E_PRODUCTION === "1" ? "start" : "dev",
      "--hostname",
      "127.0.0.1",
      "--port",
      "33117",
    ],
    { env, stdio: "inherit" },
  );
  next.on("exit", (code) => {
    process.exit(shutdown() ? code || 0 : 1);
  });
} catch (error) {
  shutdown();
  console.error(error);
  process.exit(1);
}
