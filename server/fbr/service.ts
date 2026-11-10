import { sql } from "drizzle-orm";
import { fbrInvoiceProblems, retryDelayMinutes, type FbrInvoiceInput, type FbrLine, type FbrStatus } from "../../shared/fbr";
import { formatQuantity, parseQuantity } from "../../shared/units";
import { db } from "../lib/db";
import { clientFor, loadFbrSettings, type FbrSettings } from "./config";
import { EncryptionKeyError } from "./crypto";
import { toDigitalInvoicingPayload } from "./mapper";

// Reporting posted invoices and returns to FBR (FR-FBR-10..14). The rules this file keeps:
//   * A document is queued in the SAME transaction that posts it, so it can never be posted and forgotten.
//   * One submission row for each document (unique), so it is queued, and so reported, once.
//   * FBR being down never undoes a sale: the document stays "pending" and the retry job keeps trying, 1, 5, 15, 60 minutes, then hourly.
//   * FBR refusing the data ("rejected") is not retried by itself: the owner fixes the product or customer and presses resubmit.
//   * Every request and answer is written to an append-only log.

type Executor = Pick<typeof db, "execute">;
export type FbrDocType = "sales_invoice" | "sales_return";
export type FbrOutcome = { id: string; status: FbrStatus; irn: string | null; qrData: string | null; message: string; busy?: boolean };

const tableOf = (docType: FbrDocType) => sql.raw(docType === "sales_invoice" ? "sales_invoices" : "sales_returns");
const rupeesNumber = (value: unknown) => Number(value ?? 0);

/** Does this document have to be reported? Only if FBR is on with a token, in Digital Invoicing mode, and the terminal has not opted out. */
export async function reportingApplies(executor: Executor, businessId: string, terminalId: string | null): Promise<FbrSettings | null> {
  const settings = await loadFbrSettings(businessId);
  if (!settings.enabled || !settings.tokenSet || settings.mode !== "di") return null;
  if (terminalId) {
    const [terminal] = await executor.execute<{ fbr_enabled: boolean }>(sql`select fbr_enabled from terminals where id = ${terminalId} and business_id = ${businessId}`);
    if (terminal && !terminal.fbr_enabled) return null;
  }
  return settings;
}

// ---------------------------------------------------------------- building what FBR is told

type LineRow = Record<string, unknown>;
const lineFromRow = (row: LineRow): FbrLine => ({
  // The product's code as it is now wins, so a wrong code that FBR refused can be corrected and the document sent again; the code the line was sold with is the fallback.
  hsCode: String(row.p_hs ?? "").trim() || String(row.hs_code ?? "").trim(),
  description: `${row.product_name}${row.variant_name ? ` — ${row.variant_name}` : ""}`,
  uom: String(row.fbr_uom ?? "").trim(),
  quantity: formatQuantity(parseQuantity(String(row.qty_entered))),
  valueExclTaxPaisa: rupeesNumber(row.taxable_paisa),
  taxPaisa: rupeesNumber(row.tax_paisa),
  totalPaisa: rupeesNumber(row.total_paisa),
  discountPaisa: rupeesNumber(row.line_discount_paisa) + rupeesNumber(row.invoice_discount_share_paisa),
  rateBps: Number(row.tax_rate_bps),
  saleType: String(row.fbr_sale_type ?? "").trim(),
  sroScheduleNo: String(row.fbr_sro_schedule_no ?? "").trim(),
  sroItemSerialNo: String(row.fbr_sro_item_serial_no ?? "").trim(),
});

/** The mappings a line depends on (HS code, FBR unit, sale type), read as they are now, for the products and units given. */
async function mappingFacts(executor: Executor, businessId: string, pairs: Array<{ variantId: string; unitId: string }>) {
  if (!pairs.length) return new Map<string, LineRow>();
  const rows = await executor.execute(sql`
    select v.id as variant_id, pu.unit_id, p.hs_code as p_hs, pu.fbr_uom, tc.fbr_sale_type, tc.fbr_sro_schedule_no, tc.fbr_sro_item_serial_no
    from product_variants v join products p on p.id = v.product_id left join tax_categories tc on tc.id = p.tax_category_id
    join product_units pu on pu.variant_id = v.id
    where v.business_id = ${businessId} and (v.id, pu.unit_id) in (${sql.join(pairs.map((pair) => sql`(${pair.variantId}::uuid, ${pair.unitId}::uuid)`), sql`, `)})`);
  return new Map(rows.map((row) => [`${row.variant_id}|${row.unit_id}`, row]));
}

type Buyer = FbrInvoiceInput["buyer"];
const buyerOf = (row: LineRow | undefined, snapshot?: { name?: unknown; ntn?: unknown; address?: unknown }): Buyer => {
  if (!row?.cname) return { name: "Walk-in customer", ntnCnic: "", province: "", address: "", registered: false };
  return {
    name: String(snapshot?.name || row.business_name || row.cname),
    ntnCnic: String(snapshot?.ntn || row.cntn || row.ccnic || ""),
    province: String(row.cprov ?? ""),
    address: String(snapshot?.address || row.caddr || ""),
    registered: Boolean(row.creg),
  };
};

/** The invoice or return as FBR needs it, from what is stored now. Null if the document does not exist. */
export async function loadFbrInput(executor: Executor, businessId: string, docType: FbrDocType, docId: string, settings: FbrSettings): Promise<{ input: FbrInvoiceInput; retail: boolean; originalStatus: FbrStatus | null; hasOriginal: boolean } | null> {
  const seller = { ...settings.seller };
  if (docType === "sales_invoice") {
    const [row] = await executor.execute(sql`
      select i.*, to_char(i.posted_at at time zone 'Asia/Karachi', 'YYYY-MM-DD') as day, c.name as cname, c.business_name, c.ntn as cntn, c.cnic as ccnic, c.registered as creg, c.province as cprov, c.address as caddr
      from sales_invoices i left join customers c on c.id = i.customer_id where i.id = ${docId} and i.business_id = ${businessId}`);
    if (!row) return null;
    const lines = await executor.execute(sql`
      select l.*, p.hs_code as p_hs, pu.fbr_uom, tc.fbr_sale_type, tc.fbr_sro_schedule_no, tc.fbr_sro_item_serial_no
      from sales_invoice_lines l join product_variants v on v.id = l.variant_id join products p on p.id = v.product_id
      left join product_units pu on pu.variant_id = l.variant_id and pu.unit_id = l.unit_id left join tax_categories tc on tc.id = p.tax_category_id
      where l.invoice_id = ${docId} and l.business_id = ${businessId} order by l.line_no`);
    return {
      input: {
        kind: "sale", number: String(row.number), date: String(row.day), seller, buyer: buyerOf(row, { name: row.buyer_name, ntn: row.buyer_ntn, address: row.buyer_address }),
        lines: lines.map(lineFromRow), refIrn: null, totalPaisa: rupeesNumber(row.total_paisa),
      },
      retail: row.channel === "pos", originalStatus: null, hasOriginal: true,
    };
  }
  const [row] = await executor.execute(sql`
    select r.*, to_char(r.posted_at at time zone 'Asia/Karachi', 'YYYY-MM-DD') as day, c.name as cname, c.business_name, c.ntn as cntn, c.cnic as ccnic, c.registered as creg, c.province as cprov, c.address as caddr,
           o.fbr_irn as original_irn, o.fbr_status as original_status
    from sales_returns r left join customers c on c.id = r.customer_id left join sales_invoices o on o.id = r.original_invoice_id
    where r.id = ${docId} and r.business_id = ${businessId}`);
  if (!row) return null;
  const lines = await executor.execute(sql`
    select l.*, p.hs_code as p_hs, pu.fbr_uom, tc.fbr_sale_type, tc.fbr_sro_schedule_no, tc.fbr_sro_item_serial_no
    from sales_return_lines l join product_variants v on v.id = l.variant_id join products p on p.id = v.product_id
    left join product_units pu on pu.variant_id = l.variant_id and pu.unit_id = l.unit_id left join tax_categories tc on tc.id = p.tax_category_id
    where l.return_id = ${docId} and l.business_id = ${businessId} order by l.line_no`);
  return {
    input: {
      kind: "return", number: String(row.number), date: String(row.day), seller, buyer: buyerOf(row), lines: lines.map(lineFromRow),
      refIrn: row.original_irn ? String(row.original_irn) : null, totalPaisa: rupeesNumber(row.total_paisa),
    },
    retail: true,
    originalStatus: row.original_status ? (String(row.original_status) as FbrStatus) : null,
    hasOriginal: Boolean(row.original_invoice_id),
  };
}

/**
 * Before a sale is posted: is everything FBR needs there? (FR-FBR-10) Answers the list of what to fix, or an empty list, which is also what
 * it answers when FBR does not apply. Called with the lines the till or desk is about to post.
 */
export async function fbrPreflight(businessId: string, sale: { terminalId: string | null; customerId: string | null; totalPaisa: number; lines: Array<Record<string, unknown>> }): Promise<string[]> {
  const settings = await reportingApplies(db, businessId, sale.terminalId);
  if (!settings) return [];
  const facts = await mappingFacts(db, businessId, sale.lines.map((line) => ({ variantId: String(line.variant_id), unitId: String(line.unit_id) })));
  const [customer] = sale.customerId ? await db.execute(sql`select name as cname, business_name, ntn as cntn, cnic as ccnic, registered as creg, province as cprov, address as caddr from customers where id = ${sale.customerId} and business_id = ${businessId}`) : [];
  const lines = sale.lines.map((line) => lineFromRow({ ...facts.get(`${line.variant_id}|${line.unit_id}`), ...line }));
  return fbrInvoiceProblems({
    kind: "sale", number: "", date: "", seller: settings.seller, buyer: buyerOf(customer), lines, refIrn: null, totalPaisa: sale.totalPaisa,
  }, { buyerIdThresholdPaisa: settings.buyerIdThresholdPaisa });
}

// ---------------------------------------------------------------- queueing

/** Puts a posted document on the queue, in the transaction that posted it. Returns the submission id, or null if FBR does not apply. */
export async function queueFbrSubmission(executor: Executor, businessId: string, docType: FbrDocType, docId: string, terminalId: string | null): Promise<string | null> {
  const settings = await reportingApplies(executor, businessId, terminalId);
  if (!settings) return null;
  const [doc] = await executor.execute<{ number: string }>(sql`select number from ${tableOf(docType)} where id = ${docId} and business_id = ${businessId}`);
  const number = doc?.number ?? "";
  const [row] = await executor.execute<{ id: string }>(sql`
    insert into fbr_submissions (business_id, doc_type, doc_id, number, channel, environment, status, next_retry_at)
    values (${businessId}, ${docType}, ${docId}, ${number}, 'di', ${settings.environment}, 'pending', now())
    on conflict (business_id, doc_type, doc_id) do nothing returning id`);
  if (!row) return null;
  await executor.execute(sql`update ${tableOf(docType)} set fbr_status = 'pending' where id = ${docId} and business_id = ${businessId}`);
  return row.id;
}

// ---------------------------------------------------------------- attempting

async function logAttempt(businessId: string, submissionId: string, attemptNo: number, step: "local" | "validate" | "post", outcome: string, message: string, request: unknown, response: unknown, httpStatus?: number) {
  await db.execute(sql`
    insert into fbr_attempts (business_id, submission_id, attempt_no, step, outcome, http_status, message, request, response)
    values (${businessId}, ${submissionId}, ${attemptNo}, ${step}, ${outcome}, ${httpStatus ?? null}, ${message}, ${request === undefined ? null : JSON.stringify(request)}::jsonb, ${response === undefined ? null : JSON.stringify(response)}::jsonb)`);
}

type Row = { id: string; business_id: string; doc_type: FbrDocType; doc_id: string; number: string; attempts: number; created_at: string; status: FbrStatus };

/** Records where a submission ended up and copies the result onto the document, and lets go of the claim. */
async function settle(row: Row, status: FbrStatus, fields: { irn?: string; qrData?: string; errorCode?: string | null; message?: string; response?: unknown; payload?: unknown; retryInMinutes?: number | null; countAttempt?: boolean }) {
  const attempts = row.attempts + (fields.countAttempt === false ? 0 : 1);
  await db.execute(sql`
    update fbr_submissions set status = ${status}, attempts = ${attempts}, last_attempt_at = now(), claimed_until = null, updated_at = now(),
      next_retry_at = ${fields.retryInMinutes === undefined || fields.retryInMinutes === null ? null : sql`now() + make_interval(mins => ${fields.retryInMinutes})`},
      error_code = ${fields.errorCode ?? null}, error_message = ${fields.message ?? null},
      irn = ${fields.irn ?? null}, qr_data = ${fields.qrData ?? null}, accepted_at = ${status === "accepted" ? sql`now()` : null},
      payload = coalesce(${fields.payload === undefined ? null : JSON.stringify(fields.payload)}::jsonb, payload), response = coalesce(${fields.response === undefined ? null : JSON.stringify(fields.response)}::jsonb, response)
    where id = ${row.id}`);
  await db.execute(sql`
    update ${tableOf(row.doc_type)} set fbr_status = ${status}, fbr_irn = ${fields.irn ?? null}, fbr_qr = ${fields.qrData ?? null}, fbr_at = case when ${status} = 'accepted' then now() else fbr_at end
    where id = ${row.doc_id} and business_id = ${row.business_id}`);
  return { id: row.id, status, irn: fields.irn ?? null, qrData: fields.qrData ?? null, message: fields.message ?? "" } satisfies FbrOutcome;
}

/**
 * One go at reporting a queued document. Safe to call from anywhere at any time: it takes a claim first, so two callers (the till's own
 * attempt and the retry job, say) never send the same document at once, and an accepted document is never sent again.
 */
export async function attemptSubmission(submissionId: string, options: { timeoutMs?: number } = {}): Promise<FbrOutcome> {
  const [row] = await db.execute<Row>(sql`
    update fbr_submissions set claimed_until = now() + interval '90 seconds'
    where id = ${submissionId} and status = 'pending' and (claimed_until is null or claimed_until < now()) returning id, business_id, doc_type, doc_id, number, attempts, created_at, status`);
  if (!row) {
    const [current] = await db.execute(sql`select id, status, irn, qr_data, error_message from fbr_submissions where id = ${submissionId}`);
    return { id: submissionId, status: (current?.status ?? "pending") as FbrStatus, irn: (current?.irn as string) ?? null, qrData: (current?.qr_data as string) ?? null, message: String(current?.error_message ?? ""), busy: current?.status === "pending" };
  }
  const attemptNo = row.attempts + 1;
  const settings = await loadFbrSettings(row.business_id);
  if (!settings.enabled) return settle(row, "skipped", { message: "FBR was switched off before this was reported. Resubmit it from the FBR log if it should be reported.", countAttempt: false });

  const loaded = await loadFbrInput(db, row.business_id, row.doc_type, row.doc_id, settings);
  if (!loaded) return settle(row, "skipped", { message: "The document could not be found", countAttempt: false });

  // A return is reported against the invoice it takes back, so it waits for that invoice's number.
  if (row.doc_type === "sales_return") {
    if (!loaded.hasOriginal) return settle(row, "skipped", { message: "A return with no receipt cannot be reported to FBR: there is no invoice number to refer to", countAttempt: false });
    if (!loaded.input.refIrn) {
      if (loaded.originalStatus === "pending") {
        return settle(row, "pending", { message: "Waiting for FBR to accept the invoice this return is against", retryInMinutes: 2, countAttempt: false });
      }
      // Sold before FBR was switched on (never queued), or not reportable: there is no FBR number to refer back to.
      if (loaded.originalStatus === null || loaded.originalStatus === "skipped") return settle(row, "skipped", { message: "The invoice this return is against was never reported to FBR, so there is nothing to refer to", countAttempt: false });
      return settle(row, "rejected", { errorCode: "ORIGINAL_NOT_ACCEPTED", message: `The invoice this return is against is ${loaded.originalStatus} at FBR. Fix and resubmit that invoice first.`, countAttempt: false });
    }
  }

  const problems = fbrInvoiceProblems(loaded.input, { buyerIdThresholdPaisa: settings.buyerIdThresholdPaisa });
  if (problems.length) {
    await logAttempt(row.business_id, row.id, attemptNo, "local", "rejected", problems.join("; "), undefined, undefined);
    return settle(row, "rejected", { errorCode: "LOCAL_VALIDATION", message: problems.join(". "), retryInMinutes: null });
  }

  let client;
  try {
    client = await clientFor(row.business_id, settings, options.timeoutMs);
  } catch (error) {
    if (!(error instanceof EncryptionKeyError)) throw error;
    await logAttempt(row.business_id, row.id, attemptNo, "local", "failed", error.message, undefined, undefined);
    return settle(row, "failed", { errorCode: "TOKEN_UNREADABLE", message: error.message });
  }
  if (!client) return settle(row, "failed", { errorCode: "TOKEN_MISSING", message: "No FBR token is stored. Enter it in the FBR settings and resubmit." });

  const payload = toDigitalInvoicingPayload(loaded.input, settings.environment, { retail: loaded.retail });
  const giveUp = Date.now() - new Date(row.created_at).getTime() > Math.max(settings.cancelWindowHours, 1) * 3_600_000;
  /** FBR (or the network) was not there: try again later, unless it has been too long. */
  const later = (message: string, response?: unknown) => giveUp
    ? settle(row, "failed", { errorCode: "GAVE_UP", message: `${message}. FBR could not be reached for ${settings.cancelWindowHours} hours, so this was given up. Resubmit it when FBR is back.`, payload, response })
    : settle(row, "pending", { message, retryInMinutes: retryDelayMinutes(attemptNo), payload, response });

  // Validate first: it changes nothing at FBR, so it is safe to repeat, and a refusal here means nothing was ever posted.
  const checked = await client.validate(payload);
  await logAttempt(row.business_id, row.id, attemptNo, "validate", checked.outcome, "message" in checked ? checked.message : "Valid", payload, checked.response, "httpStatus" in checked ? checked.httpStatus : undefined);
  if (checked.outcome === "transient") return later(checked.message, checked.response);
  if (checked.outcome === "unauthorised") return settle(row, "failed", { errorCode: "UNAUTHORISED", message: checked.message, payload, response: checked.response });
  if (checked.outcome === "rejected") return settle(row, "rejected", { errorCode: checked.code, message: checked.message, payload, response: checked.response });

  const posted = await client.post(payload);
  await logAttempt(row.business_id, row.id, attemptNo, "post", posted.outcome, "message" in posted ? posted.message : `Accepted as ${posted.irn}`, payload, posted.response, "httpStatus" in posted ? posted.httpStatus : undefined);
  if (posted.outcome === "accepted") return settle(row, "accepted", { irn: posted.irn, qrData: posted.qrData, response: posted.response, payload, message: "" });
  if (posted.outcome === "transient") return later(`${posted.message}. It is not certain whether FBR received it; the next attempt asks FBR again`, posted.response);
  if (posted.outcome === "unauthorised") return settle(row, "failed", { errorCode: "UNAUTHORISED", message: posted.message, payload, response: posted.response });
  return settle(row, "rejected", { errorCode: posted.code, message: posted.message, payload, response: posted.response });
}

/** The first go, right after a sale or return is posted, in the time a till can wait. Never throws: the sale already happened. */
export async function reportNow(submissionId: string | null): Promise<FbrOutcome | null> {
  if (!submissionId) return null;
  try {
    return await attemptSubmission(submissionId, { timeoutMs: 4000 });
  } catch (error) {
    console.error("FBR attempt failed", error);
    return null;
  }
}

/** The retry job: every pending submission that is due, oldest first. */
export async function runDueSubmissions(limit = 25, businessId?: string): Promise<{ tried: number; accepted: number; pending: number; rejected: number; failed: number; skipped: number }> {
  const due = await db.execute<{ id: string }>(sql`
    select id from fbr_submissions where status = 'pending' and coalesce(next_retry_at, now()) <= now() and (claimed_until is null or claimed_until < now())
    ${businessId ? sql`and business_id = ${businessId}` : sql``}
    order by coalesce(next_retry_at, created_at), created_at limit ${limit}`);
  const totals = { tried: 0, accepted: 0, pending: 0, rejected: 0, failed: 0, skipped: 0 };
  for (const { id } of due) {
    const result = await attemptSubmission(id);
    if (result.busy) continue;
    totals.tried += 1;
    totals[result.status] += 1;
  }
  return totals;
}

/** Sends a rejected, failed or waiting document again, after whatever was wrong has been fixed. An accepted one is never sent again. */
export async function resubmit(businessId: string, submissionId: string): Promise<{ error: "NOT_FOUND" | "ACCEPTED" | "WINDOW_PASSED"; message: string } | { outcome: FbrOutcome }> {
  const [row] = await db.execute<{ status: FbrStatus; doc_type: FbrDocType; doc_id: string }>(sql`select status, doc_type, doc_id from fbr_submissions where id = ${submissionId} and business_id = ${businessId}`);
  if (!row) return { error: "NOT_FOUND", message: "That submission was not found" };
  if (row.status === "accepted") return { error: "ACCEPTED", message: "FBR has already accepted this invoice; it is never reported twice" };
  const settings = await loadFbrSettings(businessId);
  if (row.status === "rejected") {
    // FBR only lets a posted invoice be corrected for a while (FR-FBR-17); the length of that window is a setting.
    const [age] = await db.execute<{ hours: number }>(sql`select extract(epoch from now() - posted_at)::float / 3600 as hours from ${tableOf(row.doc_type)} where id = ${row.doc_id}`);
    if (age && settings.cancelWindowHours > 0 && Number(age.hours) > settings.cancelWindowHours) {
      return { error: "WINDOW_PASSED", message: `This was posted more than ${settings.cancelWindowHours} hours ago, longer than FBR allows an invoice to be corrected. Ask your tax advisor how to put it right.` };
    }
  }
  await db.execute(sql`update fbr_submissions set status = 'pending', next_retry_at = now(), claimed_until = null, error_message = null, error_code = null, updated_at = now() where id = ${submissionId}`);
  await db.execute(sql`update ${tableOf(row.doc_type)} set fbr_status = 'pending' where id = ${row.doc_id} and business_id = ${businessId}`);
  return { outcome: await attemptSubmission(submissionId) };
}
