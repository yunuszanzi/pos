import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../db/schema";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const client = postgres(databaseUrl, { prepare: false, max: 5 });

export const db = drizzle(client, { schema });
/** The driver itself, for streaming a large read with a cursor (the data export). Everything else goes through `db`. */
export const rawClient = client;
export const closeDb = () => client.end();
export type Database = typeof db;
