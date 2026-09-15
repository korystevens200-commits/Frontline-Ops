/* Apply pending migrations, then exit. Run by `npm run migrate` and by the
   Fly release_command on every deploy. */
import { migrate, closePool } from "../src/env-bootstrap.js";

try {
  await migrate();
  await closePool();
  process.exit(0);
} catch (err) {
  console.error("[migrate] FAILED:", err.message);
  await closePool().catch(() => {});
  process.exit(1);
}
