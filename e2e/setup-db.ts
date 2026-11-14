import { getDb } from "../src/lib/db";
import { migrate, createOwner } from "../src/lib/persistence";
const db = getDb();
try {
  await migrate(db);
  await createOwner(db, "owner", "isolated-password-1234");
} finally {
  await db.end();
}
