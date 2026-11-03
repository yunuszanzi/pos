import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const client = postgres(databaseUrl, { prepare: false, max: 1 });
try {
  await client`CREATE TABLE IF NOT EXISTS app_schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`;
  await client`SELECT pg_advisory_lock(631071920)`;
  const alreadyApplied = new Set((await client`SELECT name FROM app_schema_migrations`).map((row) => String(row.name)));
  const directory = join(process.cwd(), "db", "migrations");
  const migrations = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right));
  for (const name of migrations) {
    if (alreadyApplied.has(name)) continue;
    const sql = await readFile(join(directory, name), "utf8");
    await client.begin(async (transaction) => {
      await transaction.unsafe(sql);
      await transaction`INSERT INTO app_schema_migrations (name) VALUES (${name})`;
    });
    console.log(`Applied ${name}`);
  }
} finally {
  await client`SELECT pg_advisory_unlock(631071920)`;
  await client.end();
}
