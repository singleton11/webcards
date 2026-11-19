import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createSocketServer } from "node:net";
const root = mkdtempSync(join(tmpdir(), "webcards-browser-pg-"));
const data = join(root, "data"),
  pg = process.env.POSTGRES_BIN || "/usr/lib/postgresql/17/bin";
let started = false,
  stopping = false;
const children = [];
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
async function shutdown() {
  stopping = true;
  await Promise.all(
    children.map(
      (child) =>
        new Promise((resolve) => {
          if (
            child.exitCode !== null ||
            child.signalCode !== null ||
            !child.pid
          )
            return resolve();
          const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
          child.kill("SIGTERM");
        }),
    ),
  );
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
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    if (!stopping) void shutdown().then((ok) => process.exit(ok ? 0 : 1));
  });
try {
  const dbPort = await port(),
    modelPort = await port(),
    apiPort = await port();
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
  const origin =
    process.env.WEBCARDS_E2E_HTTPS === "1"
      ? "https://127.0.0.1:33117"
      : "http://127.0.0.1:33117";
  const env = {
    ...process.env,
    NODE_ENV: "test",
    PORT: String(apiPort),
    WEBCARDS_E2E_FIXTURE: "1",
    DATABASE_URL:
      "postgresql://webcards_test@127.0.0.1:" + dbPort + "/postgres",
    BETTER_AUTH_URL: origin,
    BETTER_AUTH_SECRET: "isolated-test-secret-not-for-deployment-1234",
    OWNER_USERNAME: "owner",
    MODEL_API_KEY: "fixture-only",
    MODEL_NAME: "gpt-6-luna",
    MODEL_BASE_URL: "http://127.0.0.1:" + modelPort + "/v1",
    TRANSLATIONS_PER_DAY: "100",
  };
  execFileSync("./node_modules/.bin/tsx", ["e2e/setup-db.ts"], {
    env,
    stdio: "inherit",
  });
  const config = join(root, "Caddyfile");
  writeFileSync(
    config,
    `{\n\tadmin off\n\tauto_https ${process.env.WEBCARDS_E2E_HTTPS === "1" ? "disable_redirects" : "off"}\n\tdefault_bind 127.0.0.1\n\tskip_install_trust\n}\n` +
      (process.env.WEBCARDS_E2E_HTTPS === "1"
        ? readFileSync("infra/Caddyfile", "utf8").replace(
            "{$WEBCARDS_ADDRESS:webcards.example.com} {",
            "{$WEBCARDS_ADDRESS:webcards.example.com} {\n\ttls internal",
          )
        : readFileSync("infra/Caddyfile", "utf8")),
  );
  children.push(
    spawn(process.env.WEBCARDS_API_BIN || "./dist/webcards-api", [], { env, stdio: "inherit" }),
  );
  children.push(
    spawn(
      process.env.WEBCARDS_CADDY_BIN || "caddy",
      ["run", "--config", config, "--adapter", "caddyfile"],
      {
        env: {
          ...env,
          WEBCARDS_ADDRESS: origin,
          WEBCARDS_API: "127.0.0.1:" + apiPort,
          WEBCARDS_STATIC_ROOT: join(process.cwd(), "dist/frontend"),
          XDG_CONFIG_HOME: join(root, "caddy-config"),
          XDG_DATA_HOME: join(root, "caddy-data"),
        },
        stdio: "inherit",
      },
    ),
  );
  for (const child of children) {
    child.on("error", (error) => {
      console.error(error);
      if (!stopping) void shutdown().then(() => process.exit(1));
    });
    child.on("exit", (code) => {
      if (!stopping)
        void shutdown().then((ok) => process.exit(ok ? code || 1 : 1));
    });
  }
} catch (error) {
  await shutdown();
  console.error(error);
  process.exit(1);
}
