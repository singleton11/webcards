import { spawn } from "node:child_process";
const dev = process.argv.includes("--dev");
const child = dev
  ? spawn(process.execPath, ["scripts/cargo.mjs", "run", "--locked"], {
      stdio: "inherit",
    })
  : spawn("./dist/webcards-api", [], { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
