/* Loads app/.env (if present) before anything reads process.env, then
   re-exports the db helpers. Deliberately tiny -- avoids a dotenv dependency.
   Real secrets in production come from `fly secrets`, not from a file. */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const envPath = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");

if (existsSync(envPath)) {
  for (const rawLine of readFileSync(envPath, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    /* Real environment always wins over the file. */
    if (!(key in process.env)) process.env[key] = value;
  }
}

export * from "./db.js";
