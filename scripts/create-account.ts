import { readFileSync } from "node:fs";
import { getDb } from "../src/lib/db";
import { createAccount } from "../src/lib/persistence";

const [username, ...extra] = process.argv.slice(2);
if (!username || extra.length || !/^[a-z0-9_]{3,30}$/.test(username)) {
  console.error(
    "Usage: npm run account:create -- <username> (3-30 lowercase letters, numbers or underscores).",
  );
  process.exit(1);
}
// Keep passwords out of command arguments and process listings.
const password = readFileSync(0, "utf8").replace(/\r?\n$/, "");
const db = getDb();
try {
  await createAccount(db, username, password);
  console.log(
    "Account created with a separate workspace. Public registration remains disabled.",
  );
} catch {
  console.error(
    "Account creation failed. Check that the username is unused, the password is 12-128 characters, and the database is migrated and reachable. Existing accounts were not changed.",
  );
  process.exitCode = 1;
} finally {
  await db.end();
}
