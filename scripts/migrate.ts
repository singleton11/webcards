import { getDb } from "../src/lib/db";
import { migrate } from "../src/lib/persistence";
const db = getDb();
try {
  await migrate(db);
  console.log("Database migrations complete.");
} finally {
  await db.end();
}
