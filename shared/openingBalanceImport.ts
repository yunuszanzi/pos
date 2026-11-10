import { parseRupees, type Paisa } from "./money";
import { whatsappNumber } from "./khata";

// Opening balances for go-live (FR-CUS-06, FR-PUR-01), by CSV: what each customer owed the shop, or what the shop owed each
// supplier, on the day it moved to this system. One row per party, all or nothing, and only for parties with no ledger
// entries yet. A positive balance is money owed (by the customer, or to the supplier); a negative one is credit held.

export type OpeningBalanceParty = { /** "customer" or "supplier": the word used in messages. */ label: string; /** The column that names them. */ column: string };
export const customerParty: OpeningBalanceParty = { label: "customer", column: "customer" };
export const supplierParty: OpeningBalanceParty = { label: "supplier", column: "supplier" };

export const openingBalanceColumns = ["customer", "phone", "balance", "date", "note"] as const;
export const supplierOpeningBalanceColumns = ["supplier", "phone", "balance", "date", "note"] as const;
export const maxOpeningBalanceRows = 5000;

export type OpeningBalanceIssue = { row: number; field: string; message: string };

export type OpeningBalanceLookups = {
  /** Active parties by lower-case name. A name shared by two maps to more than one id. */
  idsByName: Map<string, string[]>;
  /** Active parties by phone, as WhatsApp numbers (shared/khata.ts whatsappNumber). */
  idsByPhone: Map<string, string[]>;
  /** Parties that already have ledger entries and so cannot take an opening balance. */
  withEntries: Set<string>;
  /** Today in the business's time zone, yyyy-mm-dd. */
  today: string;
};

export type OpeningBalanceLine = { row: number; customerId: string; amountPaisa: Paisa; asOf: string; note: string };
export type OpeningBalanceAnalysis = { issues: OpeningBalanceIssue[]; lines: OpeningBalanceLine[]; owedPaisa: Paisa; creditPaisa: Paisa };

const key = (text: string) => text.trim().toLowerCase();

/** A real calendar date written yyyy-mm-dd. */
function isDate(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === text;
}

/** `customerId` on a line is the party's id, whichever kind of party the file is for. */
export function analyseOpeningBalances(
  headers: string[], records: Array<Record<string, string>>, lookups: OpeningBalanceLookups, party: OpeningBalanceParty = customerParty,
): OpeningBalanceAnalysis {
  const issues: OpeningBalanceIssue[] = [];
  const empty = (): OpeningBalanceAnalysis => ({ issues, lines: [], owedPaisa: 0, creditPaisa: 0 });
  const fileIssue = (field: string, message: string) => issues.push({ row: 1, field, message });
  const columns = [party.column, "phone", "balance", "date", "note"];

  if (!headers.includes("balance")) fileIssue("balance", 'The "balance" column is required');
  if (!headers.includes(party.column) && !headers.includes("phone")) fileIssue(party.column, `The file needs a "${party.column}" or a "phone" column to say whose balance it is`);
  for (const header of headers) {
    if (header && !columns.includes(header)) fileIssue(header, `Unknown column "${header}". Expected: ${columns.join(", ")}`);
  }
  if (!records.length) fileIssue("file", "The file has a header but no balances");
  if (records.length > maxOpeningBalanceRows) fileIssue("file", `At most ${maxOpeningBalanceRows} rows can be imported at once; this file has ${records.length}`);
  if (issues.length) return empty();

  const lines: OpeningBalanceLine[] = [];
  const seen = new Map<string, number>();
  let owedPaisa = 0;
  let creditPaisa = 0;

  records.forEach((record, index) => {
    const row = index + 2;
    const issuesBefore = issues.length;
    const problem = (field: string, message: string) => issues.push({ row, field, message });
    const name = record[party.column] ?? "";
    const phone = record.phone ?? "";
    if (!name && !phone) return problem(party.column, `Name the ${party.label} by name or by phone`);

    // The phone is the surer match (names repeat); the name is used when there is no phone.
    let partyId: string | null = null;
    if (phone) {
      const number = whatsappNumber(phone);
      const matches = number ? lookups.idsByPhone.get(number) ?? [] : [];
      if (!number) problem("phone", `"${phone}" is not a phone number`);
      else if (matches.length === 0) problem("phone", `No active ${party.label} has the phone ${phone}. Add the ${party.label} first`);
      else if (matches.length > 1) problem("phone", `More than one ${party.label} has the phone ${phone}. Use one that is unique`);
      else partyId = matches[0];
    } else {
      const matches = lookups.idsByName.get(key(name)) ?? [];
      if (matches.length === 0) problem(party.column, `No active ${party.label} called "${name}". Add the ${party.label} first`);
      else if (matches.length > 1) problem(party.column, `More than one ${party.label} is called "${name}". Give the phone number as well`);
      else partyId = matches[0];
    }

    let amountPaisa = 0;
    try {
      amountPaisa = parseRupees(record.balance ?? "");
      if (amountPaisa === 0) problem("balance", "A balance of zero has nothing to load; remove the row");
    } catch {
      problem("balance", `"${record.balance ?? ""}" is not a valid amount. Use rupees with up to 2 decimals; a negative amount is credit held`);
    }

    const asOf = record.date || lookups.today;
    if (!isDate(asOf)) problem("date", `"${asOf}" is not a date. Write it as yyyy-mm-dd`);
    else if (asOf > lookups.today) problem("date", "An opening balance cannot be dated in the future");

    if (!partyId) return;
    if (lookups.withEntries.has(partyId)) problem(party.column, `${name || phone} already has entries in their ledger, so an opening balance can no longer be loaded`);
    if (issues.length > issuesBefore) return;
    const first = seen.get(partyId);
    if (first) return problem(party.column, `${name || phone} already appears on row ${first}`);
    seen.set(partyId, row);

    lines.push({ row, customerId: partyId, amountPaisa, asOf, note: record.note ?? "" });
    if (amountPaisa > 0) owedPaisa += amountPaisa;
    else creditPaisa += -amountPaisa;
  });

  return { issues, lines, owedPaisa, creditPaisa };
}

export const openingBalanceTemplateRows: string[][] = [
  [...openingBalanceColumns],
  ["Ali Traders", "", "45000.00", "2026-10-31", "Balance from the old register"],
  ["", "0300-1234567", "-1200.50", "", "Advance held"],
];

export const supplierOpeningBalanceTemplateRows: string[][] = [
  [...supplierOpeningBalanceColumns],
  ["Karachi Balloon Mills", "", "250000.00", "2026-10-31", "Unpaid bills from the old register"],
  ["", "0321-7654321", "-5000.00", "", "Advance paid"],
];
