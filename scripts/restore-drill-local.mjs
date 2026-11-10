// A rehearsal of the backup-restore drill on the local Supabase (v1.0, acceptance test 2): dump the whole database, restore it into a
// separate database, fingerprint both and compare. It proves the procedure and the reconcile script work; the real drill does the same
// with last night's backup restored into the staging project (docs/runbook.md).
//
//   npm run drill:local            needs `npx supabase start` (Docker)

import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "dotenv/config";

const run = (command, args, options = {}) => execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
const container = run("docker", ["ps", "--format", "{{.Names}}"]).split(/\r?\n/).find((name) => name.startsWith("supabase_db_"));
if (!container) { console.error("The local Supabase database is not running (npx supabase start)."); process.exit(2); }
const inside = (command) => run("docker", ["exec", container, "sh", "-c", command]);

const source = process.env.DATABASE_URL;
if (!source) { console.error("DATABASE_URL is not set"); process.exit(2); }
const target = source.replace(/\/[^/?]+(\?.*)?$/, "/restore_drill");
const folder = mkdtempSync(join(tmpdir(), "restore-drill-"));
const step = (text) => console.log(`\n== ${text}`);

step("1. Back up the database (pg_dump, custom format)");
inside("pg_dump -U postgres -d postgres -Fc --no-owner --no-privileges -f /tmp/drill.dump && ls -la /tmp/drill.dump");

step("2. Restore it into a new, empty database");
inside('psql -U postgres -q -c "drop database if exists restore_drill" -c "create database restore_drill"');
try {
  inside("pg_restore -U postgres -d restore_drill --no-owner --no-privileges /tmp/drill.dump");
} catch (error) {
  // Supabase's own vault tables refuse a plain restore; that is the only error expected, and nothing of the shop's lives there.
  const message = String(error.stderr ?? error.message);
  const errors = message.split("\n").filter((line) => line.startsWith("pg_restore: error"));
  const unexpected = errors.filter((line) => !/vault|secrets|supabase_vault/i.test(line) && !/could not execute query/.test(line));
  console.log(`   restore finished with ${errors.length} message(s) about Supabase-internal objects`);
  if (unexpected.length) console.log(unexpected.join("\n"));
}

step("3. Fingerprint the original and the restored copy");
const before = join(folder, "original.json");
const after = join(folder, "restored.json");
console.log(run("node", ["scripts/reconcile.mjs", "--url", source, "--out", before]).trim());
console.log(run("node", ["scripts/reconcile.mjs", "--url", target, "--out", after]).trim());

step("4. Compare");
try {
  console.log(run("node", ["scripts/reconcile.mjs", "--compare", before, after]).trim());
} catch (error) {
  console.error(String(error.stderr ?? error.message));
  process.exitCode = 1;
}
inside('psql -U postgres -q -c "drop database if exists restore_drill"; rm -f /tmp/drill.dump');
console.log(process.exitCode ? "\nDRILL FAILED" : "\nDRILL PASSED: the restored database matches the original.");
