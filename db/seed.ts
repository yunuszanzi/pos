import "dotenv/config";
import { permissionDefinitions } from "../shared/permissions";
import { permissions } from "./schema";
import { closeDb, db } from "../server/lib/db";

try {
  await db.insert(permissions).values(permissionDefinitions.map(([key, description]) => ({ key, description }))).onConflictDoNothing();
  console.log("Seeded Foundation permission definitions");
} finally {
  await closeDb();
}
