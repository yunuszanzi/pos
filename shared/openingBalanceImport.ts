import { parseRupees, type Paisa } from "./money";
import { whatsappNumber } from "./khata";

// Customer opening balances for go-live (FR-CUS-06), by CSV: what each customer owed on the day the shop moved to this
// system. One row per customer, all or nothing, and only for customers with no ledger entries yet. A positive balance is
// money the customer owes (khata); a negative one is credit we hold for them.

export const openingBalanceColumns = ["customer", "phone", "balance", "date", "note"] as const;
export const maxOpeningBalanceRows = 5000;

export type OpeningBalanceIssue = { row: number; field: string; message: string };

export type OpeningBalanceLookups = {
  /** Active customers by lower-case name. A name shared by two customers maps to more than one id. */
  idsByName: Map<string, string[]>;
  /** Active customers by phone, as WhatsApp numbers (shared/khata.ts whatsappNumber). */
  idsByPhone: Map<string, string[]>;
  /** Customers that already have ledger entries and so cannot take an opening balance. */
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

export function analyseOpeningBalances(headers: string[], records: Array<Record<string, string>>, lookups: OpeningBalanceLookups): OpeningBalanceAnalysis {
  const issues: OpeningBalanceIssue[] = [];
  const empty = (): OpeningBalanceAnalysis => ({ issues, lines: [], owedPaisa: 0, creditPaisa: 0 });
  const fileIssue = (field: string, message: string) => issues.push({ row: 1, field, message });

  if (!headers.includes("balance")) fileIssue("balance", 'The "balance" column is required');
  if (!headers.includes("customer") && !headers.includes("phone")) fileIssue("customer", 'The file needs a "customer" or a "phone" column to say whose balance it is');
  for (const header of headers) {
    if (header && !(openingBalanceColumns as readonly string[]).includes(header)) {
      fileIssue(header, `Unknown column "${header}". Expected: ${openingBalanceColumns.join(", ")}`);
    }
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
    const problem =(field: string, message: string) => issues.push({ row, field, message });
    const name = record.customer ?? "";
    const phone = record.phone ?? "";
    if (!name && !phone) return problem("customer", "Name the customer by name or by phone");

    // The phone is the surer match (names repeat); the name is used when there is no phone.
    let customerId: string | null = null;
    if (phone) {
      const number = whatsappNumber(phone);
      const matches = number ? lookups.idsByPhone.get(number) ?? [] : [];
      if (!number) problem("phone", `"${phone}" is not a phone number`);
      else if (matches.length === 0) problem("phone", `No active customer has the phone ${phone}. Add the customer first`);
      else if (matches.length > 1) problem("phone", `More than one customer has the phone ${phone}. Use one that is unique`);
      else customerId = matches[0];
    } else {
      const matches = lookups.idsByName.get(key(name)) ?? [];
      if (matches.length === 0) problem("customer", `No active customer called "${name}". Add the customer first`);
      else if (matches.length > 1) problem("customer", `More than one customer is called "${name}". Give the phone number as well`);
      else customerId = matches[0];
    }

    let amountPaisa = 0;
    try {
      amountPaisa = parseRupees(record.balance ?? "");
      if (amountPaisa === 0) problem("balance", "A balance of zero has nothing to load; remove the row");
    } catch {
      problem("balance", `"${record.balance ?? ""}" is not a valid amount. Use rupees with up to 2 decimals; a negative amount is credit we hold`);
    }

    const asOf = record.date || lookups.today;
    if (!isDate(asOf)) problem("date", `"${asOf}" is not a date. Write it as yyyy-mm-dd`);
    else if (asOf > lookups.today) problem("date", "An opening balance cannot be dated in the future");

    if (!customerId) return;
    if (lookups.withEntries.has(customerId)) problem("customer", `${name || phone} already has entries in their khata, so an opening balance can no longer be loaded`);
    if (issues.length > issuesBefore) return;
    const first = seen.get(customerId);
    if (first) return problem("customer", `${name || phone} already appears on row ${first}`);
    seen.set(customerId, row);

    lines.push({ row, customerId, amountPaisa, asOf, note: record.note ?? "" });
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
