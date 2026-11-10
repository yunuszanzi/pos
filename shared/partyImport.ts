import { customerSchema, type CustomerInput } from "./schemas/customers";
import { supplierSchema, type SupplierInput } from "./schemas/suppliers";
import { parseRupees } from "./money";

// Customers and suppliers by CSV, for go-live: the people the shop already deals with, loaded once instead of typed in one by one.
// One row per party, all or nothing. The file is checked row by row with the same rules as the forms; nothing is saved until every row is fine.

export type PartyKind = "customer" | "supplier";
export type PartyImportIssue = { row: number; field: string; message: string };

export const customerImportColumns = ["name", "business_name", "phone", "phone2", "whatsapp", "email", "address", "cnic", "ntn", "strn", "registered", "credit_limit", "terms_days", "notes"] as const;
export const supplierImportColumns = ["name", "contact_person", "phone", "whatsapp", "email", "address", "ntn", "strn", "registered", "terms_days", "notes"] as const;
export const maxPartyImportRows = 5000;

export const customerTemplateRows = [
  [...customerImportColumns],
  ["Bilal Wholesale", "Bilal Traders", "0301-1111111", "", "0301-1111111", "", "Shop 9, Jodia Bazaar, Karachi", "42101-1234567-1", "", "", "no", "50000.00", "15", "Pays on Fridays"],
];
export const supplierTemplateRows = [
  [...supplierImportColumns],
  ["Karachi Balloon Mills", "Imran", "021-32100000", "", "sales@example.com", "SITE Area, Karachi", "1234567-8", "17-00-1234-567-89", "yes", "30", ""],
];

/** What the shop already holds, to find the rows that would repeat someone. */
export type PartyLookups = {
  /** Lower-case names already in use (suppliers must be unique by name). */
  names: Set<string>;
  /** Customer CNICs already in use, digits only (customers must be unique by CNIC). */
  cnics: Set<string>;
  /** "name|phone digits" already held, so loading the same customer file twice is caught for customers who have no CNIC. */
  namePhones: Set<string>;
};

export type PartyAnalysis<T> = { issues: PartyImportIssue[]; rows: Array<{ row: number; input: T }> };

const flag = (text: string): boolean | null => {
  const value = text.trim().toLowerCase();
  if (["yes", "y", "true", "1", "registered"].includes(value)) return true;
  if (["no", "n", "false", "0", ""].includes(value)) return false;
  return null;
};
const digits = (text: string) => text.replace(/\D/g, "");

/** Reads the cells that need more than trimming: yes/no, rupees, whole days. A problem is reported against its column. */
function convert(record: Record<string, string>, kind: PartyKind, row: number, issues: PartyImportIssue[]) {
  const input: Record<string, unknown> = {};
  const fail = (field: string, message: string) => issues.push({ row, field, message });
  for (const [column, value] of Object.entries(record)) {
    if (column === "registered") {
      const parsed = flag(value);
      if (parsed === null) fail(column, 'Write "yes" or "no"');
      else input.registered = parsed;
    } else if (column === "credit_limit") {
      if (value) {
        try {
          const paisa = parseRupees(value);
          if (paisa < 0) fail(column, "A credit limit cannot be negative");
          else input.creditLimitPaisa = paisa;
        } catch {
          fail(column, "Use rupees with up to two decimals, for example 50000.00");
        }
      }
    } else if (column === "terms_days") {
      if (value) {
        if (!/^\d{1,3}$/.test(value)) fail(column, "Use a whole number of days, for example 15");
        else input.termsDays = Number(value);
      }
    } else {
      // business_name -> businessName, contact_person -> contactPerson
      input[column.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())] = value;
    }
  }
  return input as Record<string, unknown> & { kind?: PartyKind };
}

export function analyseParties(kind: "customer", headers: string[], records: Array<Record<string, string>>, lookups: PartyLookups): PartyAnalysis<CustomerInput>;
export function analyseParties(kind: "supplier", headers: string[], records: Array<Record<string, string>>, lookups: PartyLookups): PartyAnalysis<SupplierInput>;
export function analyseParties(kind: PartyKind, headers: string[], records: Array<Record<string, string>>, lookups: PartyLookups): PartyAnalysis<CustomerInput | SupplierInput> {
  const issues: PartyImportIssue[] = [];
  const columns: readonly string[] = kind === "customer" ? customerImportColumns : supplierImportColumns;
  const fileIssue = (field: string, message: string) => issues.push({ row: 1, field, message });
  if (!headers.includes("name")) fileIssue("name", 'The "name" column is required');
  for (const header of headers) if (header && !columns.includes(header)) fileIssue(header, `Unknown column "${header}". Expected: ${columns.join(", ")}`);
  if (!records.length) fileIssue("file", "The file has a header but no rows");
  if (records.length > maxPartyImportRows) fileIssue("file", `At most ${maxPartyImportRows} rows can be imported at once; this file has ${records.length}`);
  if (issues.length) return { issues, rows: [] };

  const rows: PartyAnalysis<CustomerInput | SupplierInput>["rows"] = [];
  const seenNames = new Set<string>();
  const seenCnics = new Set<string>();
  const seenNamePhones = new Set<string>();
  records.forEach((record, index) => {
    const row = index + 2;
    const before = issues.length;
    const converted = convert(record, kind, row, issues);
    const parsed = kind === "customer" ? customerSchema.safeParse(converted) : supplierSchema.safeParse(converted);
    if (!parsed.success) {
      for (const problem of parsed.error.issues) issues.push({ row, field: String(problem.path[0] ?? "row").replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`), message: problem.message });
      return;
    }
    if (issues.length > before) return;
    const input = parsed.data;
    const name = input.name.trim().toLowerCase();
    if (kind === "supplier") {
      if (lookups.names.has(name)) issues.push({ row, field: "name", message: `A supplier called "${input.name}" already exists` });
      else if (seenNames.has(name)) issues.push({ row, field: "name", message: `"${input.name}" appears twice in the file` });
      seenNames.add(name);
    } else {
      const cnic = (input as CustomerInput & { cnic: string | null }).cnic;
      if (cnic) {
        if (lookups.cnics.has(cnic)) issues.push({ row, field: "cnic", message: "A customer with this CNIC already exists" });
        else if (seenCnics.has(cnic)) issues.push({ row, field: "cnic", message: "This CNIC appears twice in the file" });
        seenCnics.add(cnic);
      } else {
        const namePhone = `${name}|${digits(input.phone ?? "")}`;
        if (lookups.namePhones.has(namePhone)) issues.push({ row, field: "name", message: `A customer called "${input.name}" with this phone already exists` });
        else if (seenNamePhones.has(namePhone)) issues.push({ row, field: "name", message: `"${input.name}" with this phone appears twice in the file` });
        seenNamePhones.add(namePhone);
      }
    }
    if (issues.length === before) rows.push({ row, input });
  });
  return { issues, rows: issues.length ? [] : rows };
}
