import { readFileSync } from "node:fs";
import { getDb } from "../src/lib/db";
import { getConfig } from "../src/lib/config";
import { createOwner } from "../src/lib/persistence";
// Read the password from stdin, never command arguments or a committed file.
const password = readFileSync(0, "utf8").replace(/\r?\n$/, "");
const db = getDb();
try {
  await createOwner(db, getConfig().OWNER_USERNAME, password);
  console.log("Owner created. Public registration remains disabled.");
} finally {
  await db.end();
}
