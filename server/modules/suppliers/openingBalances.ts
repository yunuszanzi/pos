import { and, eq, sql } from "drizzle-orm";
import { businessSettings, partyLedger, suppliers } from "../../../db/schema";
import { csvToRecords, parseCsv } from "../../../shared/csv";
import { whatsappNumber } from "../../../shared/khata";
import { analyseOpeningBalances, supplierParty, type OpeningBalanceAnalysis } from "../../../shared/openingBalanceImport";
import type { db } from "../../lib/db";
import { OpeningBalanceFileError } from "../customers/openingBalances";

type Executor = Pick<typeof db, "select" | "selectDistinct" | "execute">;

const lower = (text: string) => text.trim().toLowerCase();

function addTo(map: Map<string, string[]>, key: string, id: string) {
  const ids = map.get(key) ?? [];
  if (!ids.includes(id)) ids.push(id);
  map.set(key, ids);
}

/** Checks a file of what the shop owed each supplier at go-live against the business's active suppliers. Nothing is saved. */
export async function analyseSupplierOpeningFile(executor: Executor, businessId: string, csv: string): Promise<OpeningBalanceAnalysis> {
  let parsed: ReturnType<typeof csvToRecords>;
  try {
    parsed = csvToRecords(parseCsv(csv));
  } catch (error) {
    throw new OpeningBalanceFileError(error instanceof Error ? error.message : "The file could not be read as CSV");
  }
  const [people, entered, [settings]] = await Promise.all([
    executor.select({ id: suppliers.id, name: suppliers.name, phone: suppliers.phone, whatsapp: suppliers.whatsapp })
      .from(suppliers).where(and(eq(suppliers.businessId, businessId), eq(suppliers.active, true))),
    executor.selectDistinct({ id: partyLedger.partyId }).from(partyLedger).where(and(eq(partyLedger.businessId, businessId), eq(partyLedger.partyType, "supplier"))),
    executor.select({ timezone: businessSettings.timezone }).from(businessSettings).where(eq(businessSettings.businessId, businessId)).limit(1),
  ]);
  const timezone = settings?.timezone ?? "Asia/Karachi";
  const [{ today }] = await executor.execute<{ today: string }>(sql`select to_char(now() at time zone ${timezone}, 'YYYY-MM-DD') as today`);

  const idsByName = new Map<string, string[]>();
  const idsByPhone = new Map<string, string[]>();
  for (const person of people) {
    addTo(idsByName, lower(person.name), person.id);
    for (const phone of [person.phone, person.whatsapp]) {
      const number = phone ? whatsappNumber(phone) : null;
      if (number) addTo(idsByPhone, number, person.id);
    }
  }
  return analyseOpeningBalances(parsed.headers, parsed.records, { idsByName, idsByPhone, withEntries: new Set(entered.map((row) => row.id)), today }, supplierParty);
}
