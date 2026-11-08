import { and, eq, sql } from "drizzle-orm";
import { businessSettings, customers, partyLedger } from "../../../db/schema";
import { csvToRecords, parseCsv } from "../../../shared/csv";
import { whatsappNumber } from "../../../shared/khata";
import { analyseOpeningBalances, type OpeningBalanceAnalysis, type OpeningBalanceLookups } from "../../../shared/openingBalanceImport";
import type { db } from "../../lib/db";

type Executor = Pick<typeof db, "select" | "selectDistinct" | "execute">;

export class OpeningBalanceFileError extends Error {}

const lower = (text: string) => text.trim().toLowerCase();

function addTo(map: Map<string, string[]>, key: string, id: string) {
  const ids = map.get(key) ?? [];
  if (!ids.includes(id)) ids.push(id);
  map.set(key, ids);
}

/** Checks a file against the business's customers. Nothing is saved. */
export async function analyseOpeningBalanceFile(executor: Executor, businessId: string, csv: string): Promise<OpeningBalanceAnalysis> {
  let parsed: ReturnType<typeof csvToRecords>;
  try {
    parsed = csvToRecords(parseCsv(csv));
  } catch (error) {
    throw new OpeningBalanceFileError(error instanceof Error ? error.message : "The file could not be read as CSV");
  }
  const [people, entered, [settings]] = await Promise.all([
    executor.select({ id: customers.id, name: customers.name, phone: customers.phone, phone2: customers.phone2, whatsapp: customers.whatsapp })
      .from(customers).where(and(eq(customers.businessId, businessId), eq(customers.active, true))),
    executor.selectDistinct({ id: partyLedger.partyId }).from(partyLedger).where(and(eq(partyLedger.businessId, businessId), eq(partyLedger.partyType, "customer"))),
    executor.select({ timezone: businessSettings.timezone }).from(businessSettings).where(eq(businessSettings.businessId, businessId)).limit(1),
  ]);
  const timezone = settings?.timezone ?? "Asia/Karachi";
  const [{ today }] = await executor.execute<{ today: string }>(sql`select to_char(now() at time zone ${timezone}, 'YYYY-MM-DD') as today`);

  const idsByName = new Map<string, string[]>();
  const idsByPhone = new Map<string, string[]>();
  for (const person of people) {
    addTo(idsByName, lower(person.name), person.id);
    for (const phone of [person.phone, person.phone2, person.whatsapp]) {
      const number = phone ? whatsappNumber(phone) : null;
      if (number) addTo(idsByPhone, number, person.id);
    }
  }
  const lookups: OpeningBalanceLookups = { idsByName, idsByPhone, withEntries: new Set(entered.map((row) => row.id)), today };
  return analyseOpeningBalances(parsed.headers, parsed.records, lookups);
}
