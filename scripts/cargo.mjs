import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const cargo =
  process.env.CARGO ||
  (process.env.HOME && existsSync(join(process.env.HOME, ".cargo/bin/cargo"))
    ? join(process.env.HOME, ".cargo/bin/cargo")
    : "cargo");
const child = spawnSync(cargo, process.argv.slice(2), { stdio: "inherit" });
if (child.error) console.error(child.error.message);
process.exit(child.status ?? 1);
