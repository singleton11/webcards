import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
export async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
export async function disposablePostgres() {
  const root = mkdtempSync(join(tmpdir(), "webcards-pg-"));
  const bin = process.env.POSTGRES_BIN ?? "/usr/lib/postgresql/17/bin";
  const port = await freePort();
  const data = join(root, "data");
  try {
    execFileSync(
      join(bin, "initdb"),
      [
        "-D",
        data,
        "--auth=trust",
        "--username=webcards_test",
        "--no-locale",
        "--encoding=UTF8",
      ],
      { stdio: "pipe" },
    );
    execFileSync(
      join(bin, "pg_ctl"),
      [
        "-D",
        data,
        "-l",
        join(root, "postgres.log"),
        "-o",
        "-h 127.0.0.1 -p " + port + " -k " + root,
        "-w",
        "start",
      ],
      { stdio: "pipe" },
    );
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    url: "postgresql://webcards_test@127.0.0.1:" + port + "/postgres",
    stop() {
      execFileSync(
        join(bin, "pg_ctl"),
        ["-D", data, "-m", "immediate", "-w", "stop"],
        { stdio: "pipe" },
      );
      rmSync(root, { recursive: true, force: true });
    },
  };
}
export function testEnvironment(
  databaseUrl: string,
  origin = "http://127.0.0.1:3000",
) {
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl,
    BETTER_AUTH_URL: origin,
    BETTER_AUTH_SECRET: "isolated-test-secret-not-for-deployment-1234",
    OWNER_USERNAME: "owner",
    LITELLM_API_KEY: "fixture-only",
    LITELLM_MODEL: "chatgpt-gpt-6-luna",
  });
}
