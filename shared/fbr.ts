import { formatBps } from "./money";

// What the shop needs to know about FBR, shared by the server (which talks to FBR) and the screens (which only show the result).
// Nothing here calls FBR. The field names and rules follow PRAL's Digital Invoicing API as published; FBR revises them, so anything that
// looks like a code table is configuration the owner can sync, not a fact this file owns.

export const fbrModes = ["di", "pos", "both"] as const;
export type FbrMode = (typeof fbrModes)[number];
export const fbrModeLabels: Record<FbrMode, string> = {
  di: "Digital Invoicing (sales-tax-registered businesses, wholesale)",
  pos: "POS fiscalisation (counter retail)",
  both: "Both: counter sales by POS, desk invoices by Digital Invoicing",
};

export const fbrEnvironments = ["sandbox", "production"] as const;
export type FbrEnvironment = (typeof fbrEnvironments)[number];

/** pending: waiting to be sent or to be sent again. accepted: FBR gave it a number. rejected: FBR refused it, fix the data and resubmit.
 *  failed: given up (the token was refused, or it was tried for the whole window). skipped: not reportable, with the reason on the log. */
export const fbrStatuses = ["pending", "accepted", "rejected", "failed", "skipped"] as const;
export type FbrStatus = (typeof fbrStatuses)[number];
export const fbrStatusLabels: Record<FbrStatus, string> = { pending: "Pending", accepted: "Accepted", rejected: "Rejected", failed: "Failed", skipped: "Not reported" };

export const defaultSaleType = "Goods at standard rate (default)";
export const fbrReferenceKinds = ["province", "hs_code", "uom", "sale_type"] as const;
export type FbrReferenceKind = (typeof fbrReferenceKinds)[number];
export const fbrReferenceLabels: Record<FbrReferenceKind, string> = { province: "Provinces", hs_code: "HS codes", uom: "Units of measure", sale_type: "Sale types" };

// ---------------------------------------------------------------- the invoice as FBR is told about it

export type FbrParty = { name: string; ntnCnic: string; province: string; address: string };
export type FbrLine = {
  hsCode: string;
  description: string;
  uom: string;
  /** In the unit sold, as text with up to three decimals. */
  quantity: string;
  /** Without tax, after discounts. */
  valueExclTaxPaisa: number;
  taxPaisa: number;
  /** What the customer pays for the line. */
  totalPaisa: number;
  discountPaisa: number;
  rateBps: number;
  saleType: string;
  sroScheduleNo: string;
  sroItemSerialNo: string;
};
export type FbrInvoiceInput = {
  kind: "sale" | "return";
  /** Our number for it (INV-KHI-000042); also what the log shows. */
  number: string;
  /** yyyy-mm-dd in Karachi. */
  date: string;
  seller: FbrParty & { strn: string };
  buyer: FbrParty & { registered: boolean };
  lines: FbrLine[];
  /** For a return: the IRN of the invoice it takes back. */
  refIrn: string | null;
  totalPaisa: number;
};

const digits = (text: string) => text.replace(/\D/g, "");
/** An NTN has 7 digits (or 8 with its check digit) and a CNIC 13. Dashes and spaces are ignored. */
export const isTaxNumber = (text: string) => [7, 8, 13].includes(digits(text).length);
/** HS codes are written 0000.0000. */
export const normaliseHsCode = (text: string) => {
  const found = /^(\d{4})\.?(\d{4})$/.exec(text.trim());
  return found ? `${found[1]}.${found[2]}` : text.trim();
};
export const isHsCode = (text: string) => /^\d{4}\.\d{4}$/.test(normaliseHsCode(text));

/** The tax rate as FBR writes it: "18%", or "Exempt" for exempt goods. */
export const fbrRateText = (rateBps: number, saleType: string) => (/exempt/i.test(saleType) ? "Exempt" : `${formatBps(rateBps)}%`);

/**
 * Everything that is missing or wrong, in words a shop owner can act on, before the invoice goes anywhere (FR-FBR-10). Nothing is sent
 * for an invoice that has any of these; the till says what to fix.
 */
export function fbrInvoiceProblems(invoice: FbrInvoiceInput, rules: { buyerIdThresholdPaisa: number }): string[] {
  const problems: string[] = [];
  const { seller, buyer } = invoice;
  if (!seller.name.trim()) problems.push("Enter the seller's business name in the FBR settings");
  if (!isTaxNumber(seller.ntnCnic)) problems.push("Enter the seller's NTN in the FBR settings");
  if (!seller.province.trim()) problems.push("Choose the seller's province in the FBR settings");
  if (!seller.address.trim()) problems.push("Enter the seller's address in the FBR settings");
  if (!invoice.lines.length) problems.push("The invoice has no items");
  invoice.lines.forEach((line, index) => {
    const what = `${line.description || `Item ${index + 1}`}`;
    if (!line.hsCode.trim()) problems.push(`${what}: add its HS code (on the product)`);
    else if (!isHsCode(line.hsCode)) problems.push(`${what}: the HS code "${line.hsCode}" should look like 9503.0090`);
    if (!line.uom.trim()) problems.push(`${what}: add its FBR unit of measure (on the product's unit)`);
    if (!line.saleType.trim()) problems.push(`${what}: add the FBR sale type to its tax category`);
    if (Number(line.quantity) <= 0) problems.push(`${what}: the quantity must be more than zero`);
    if (line.rateBps < 0 || line.rateBps > 10_000) problems.push(`${what}: the tax rate is not valid`);
  });
  if (buyer.registered && !isTaxNumber(buyer.ntnCnic)) problems.push(`${buyer.name || "The buyer"} is registered for sales tax: add their NTN to the customer`);
  if (!buyer.registered && invoice.totalPaisa >= rules.buyerIdThresholdPaisa && !isTaxNumber(buyer.ntnCnic)) {
    problems.push("This sale is large enough that FBR needs the buyer's CNIC or NTN: choose the customer and add it to them");
  }
  if (invoice.kind === "return" && !invoice.refIrn) problems.push("The invoice this return is against has not been accepted by FBR yet");
  return problems;
}

// ---------------------------------------------------------------- retrying

/** How long to wait before trying again: 1, 5, 15 and 60 minutes, then every hour (technical plan 5.4). */
export function retryDelayMinutes(attemptsMade: number): number {
  return [1, 5, 15, 60][Math.max(0, attemptsMade - 1)] ?? 60;
}
/** After this many hours of trying, a pending submission is given up as failed and raised on the dashboard. */
export const retryGiveUpHours = 72;

// ---------------------------------------------------------------- the sandbox scenarios (FR-FBR-06)

/** The PRAL sandbox test scenarios a business is asked to pass before it switches to production. Which apply depends on what it sells. */
export const sandboxScenarios = [
  { id: "SN001", title: "Goods at standard rate to a registered buyer", saleType: "Goods at standard rate (default)", rateBps: 1800, registered: true },
  { id: "SN002", title: "Goods at standard rate to an unregistered buyer", saleType: "Goods at standard rate (default)", rateBps: 1800, registered: false },
  { id: "SN005", title: "Goods at reduced rate", saleType: "Goods at Reduced Rate", rateBps: 500, registered: true },
  { id: "SN006", title: "Exempt goods", saleType: "Exempt goods", rateBps: 0, registered: true },
  { id: "SN007", title: "Zero-rated goods", saleType: "Goods at zero-rate", rateBps: 0, registered: true },
  { id: "SN008", title: "Third Schedule goods", saleType: "3rd Schedule Goods", rateBps: 1800, registered: true },
  { id: "SN026", title: "Standard rate goods sold by a retailer to an end consumer", saleType: "Goods at standard rate (default)", rateBps: 1800, registered: false },
  { id: "SN027", title: "Third Schedule goods sold by a retailer to an end consumer", saleType: "3rd Schedule Goods", rateBps: 1800, registered: false },
  { id: "SN028", title: "Reduced rate goods sold by a retailer to an end consumer", saleType: "Goods at Reduced Rate", rateBps: 500, registered: false },
] as const;

/** The scenario id the sandbox wants on an invoice, from what is being sold and to whom. Production ignores it. */
export function scenarioFor(saleType: string, registered: boolean, retail: boolean): string {
  const type = saleType.toLowerCase();
  if (type.includes("exempt")) return "SN006";
  if (type.includes("zero")) return "SN007";
  if (type.includes("3rd schedule")) return retail && !registered ? "SN027" : "SN008";
  if (type.includes("reduced")) return retail && !registered ? "SN028" : "SN005";
  if (retail && !registered) return "SN026";
  return registered ? "SN001" : "SN002";
}
