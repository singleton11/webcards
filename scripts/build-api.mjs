import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
execFileSync(
  process.execPath,
  ["scripts/cargo.mjs", "build", "--release", "--locked"],
  { stdio: "inherit" },
);
mkdirSync("dist", { recursive: true });
copyFileSync("target/release/webcards-api", "dist/webcards-api");
copyFileSync("licenses/ts-fsrs.txt", "dist/ts-fsrs-LICENSE.txt");
