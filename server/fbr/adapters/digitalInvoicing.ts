import type { FbrReferenceKind } from "../../../shared/fbr";
import type { FbrBuyerCheck, FbrClient, FbrClientSettings, FbrFailure, FbrPosted, FbrReferenceItem, FbrReferenceResult, FbrValidated } from "../types";

// PRAL's Digital Invoicing API (https://gw.fbr.gov.pk). Nothing here is hard-coded into the rest of the system: the base address, the
// environment and the token arrive with the settings. The paths and the shape of the answers follow PRAL's published technical document
// (DI API v1.12). FBR revises it; if an answer is not in a shape this file knows, the invoice is NOT treated as accepted.

const baseUrl = "https://gw.fbr.gov.pk";
const paths = {
  validate: { sandbox: "/di_data/v1/di/validateinvoicedata_sb", production: "/di_data/v1/di/validateinvoicedata" },
  post: { sandbox: "/di_data/v1/di/postinvoicedata_sb", production: "/di_data/v1/di/postinvoicedata" },
  reference: { province: "/pdi/v1/provinces", hs_code: "/pdi/v1/itemdesccode", uom: "/pdi/v1/uom", sale_type: "/pdi/v1/transtypecode" } satisfies Record<FbrReferenceKind, string>,
  registration: "/dist/v1/Get_Reg_Type",
};

type Json = Record<string, unknown>;
type Reply = { status: number; body: Json | unknown[] | null } | { networkError: string };

const asText = (value: unknown) => (typeof value === "string" ? value : value === null || value === undefined ? "" : String(value));

export class DigitalInvoicingAdapter implements FbrClient {
  readonly name = "digital-invoicing";
  constructor(private readonly settings: FbrClientSettings, private readonly fetcher: typeof fetch = fetch) {}

  private async send(method: "GET" | "POST", path: string, body?: unknown): Promise<Reply> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.settings.timeoutMs);
    try {
      const response = await this.fetcher(`${baseUrl}${path}`, {
        method, signal: controller.signal,
        headers: { Authorization: `Bearer ${this.settings.token}`, "Content-Type": "application/json", Accept: "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const parsed = await response.json().catch(() => null) as Json | unknown[] | null;
      return { status: response.status, body: parsed };
    } catch (error) {
      const aborted = (error as { name?: string })?.name === "AbortError";
      return { networkError: aborted ? "FBR did not answer in time" : `FBR could not be reached (${(error as Error)?.message ?? "network error"})` };
    } finally {
      clearTimeout(timer);
    }
  }

  /** The failures every call can have, sorted: no answer or an FBR fault is worth trying again; a refused token is not. */
  private failure(reply: Reply): FbrFailure | null {
    if ("networkError" in reply) return { outcome: "transient", message: reply.networkError };
    const { status, body } = reply;
    if (status === 401 || status === 403) return { outcome: "unauthorised", message: "FBR refused the security token. Check the token in the FBR settings.", httpStatus: status, response: body };
    if (status === 429 || status >= 500) return { outcome: "transient", message: `FBR is not available right now (HTTP ${status})`, httpStatus: status, response: body };
    return null;
  }

  /** PRAL answers 200 with validationResponse.statusCode "00" when the invoice is valid; anything else carries the reason. */
  private rejection(reply: { status: number; body: Json | unknown[] | null }): FbrFailure | null {
    const body = (reply.body ?? {}) as Json;
    const validation = (body.validationResponse ?? body) as Json;
    const statusCode = asText(validation.statusCode);
    if (reply.status >= 200 && reply.status < 300 && statusCode === "00") return null;
    const items = Array.isArray(validation.invoiceStatuses) ? (validation.invoiceStatuses as Json[]) : [];
    const firstBad = items.find((item) => asText(item.statusCode) !== "00");
    const message = asText(firstBad?.error) || asText(validation.error) || asText(body.message) || `FBR did not accept the invoice (HTTP ${reply.status})`;
    return { outcome: "rejected", code: asText(firstBad?.errorCode) || statusCode || String(reply.status), message: firstBad?.itemSNo ? `Item ${asText(firstBad.itemSNo)}: ${message}` : message, httpStatus: reply.status, response: reply.body };
  }

  async validate(payload: unknown): Promise<FbrValidated> {
    const reply = await this.send("POST", paths.validate[this.settings.environment], payload);
    const failure = this.failure(reply);
    if (failure) return failure;
    const answered = reply as { status: number; body: Json | unknown[] | null };
    return this.rejection(answered) ?? { outcome: "valid", httpStatus: answered.status, response: answered.body };
  }

  async post(payload: unknown): Promise<FbrPosted> {
    const reply = await this.send("POST", paths.post[this.settings.environment], payload);
    const failure = this.failure(reply);
    if (failure) return failure;
    const answered = reply as { status: number; body: Json | unknown[] | null };
    const rejected = this.rejection(answered);
    if (rejected) return rejected;
    const irn = asText((answered.body as Json | null)?.invoiceNumber);
    // A "valid" answer with no invoice number is not an acceptance: without FBR's number there is nothing to print or refer back to.
    if (!irn) return { outcome: "rejected", code: "NO_IRN", message: "FBR answered without an invoice number", httpStatus: answered.status, response: answered.body };
    return { outcome: "accepted", irn, qrData: irn, httpStatus: answered.status, response: answered.body };
  }

  async testConnection() {
    const reply = await this.send("GET", paths.reference.province);
    const failure = this.failure(reply);
    if (failure) return { ok: false, message: failure.message };
    const answered = reply as { status: number };
    if (answered.status >= 200 && answered.status < 300) return { ok: true, message: `Connected to FBR (${this.settings.environment}). The token was accepted.` };
    return { ok: false, message: `FBR answered HTTP ${answered.status}` };
  }

  async fetchReference(kind: FbrReferenceKind): Promise<FbrReferenceResult> {
    const reply = await this.send("GET", paths.reference[kind]);
    const failure = this.failure(reply);
    if (failure) return { ok: false, message: failure.message };
    const answered = reply as { status: number; body: Json | unknown[] | null };
    if (answered.status < 200 || answered.status >= 300 || !Array.isArray(answered.body)) return { ok: false, message: `FBR answered HTTP ${answered.status} with a list this system cannot read` };
    const items: FbrReferenceItem[] = [];
    for (const entry of answered.body as Json[]) {
      // Each list names its code and description differently; take what is there.
      const code = asText(entry.stateProvinceDesc ?? entry.hS_CODE ?? entry.hsCode ?? entry.UOM_ID ?? entry.uoM_ID ?? entry.uoMId ?? entry.transactioN_TYPE_ID ?? entry.transactionTypeId ?? entry.code ?? entry.id);
      const description = asText(entry.stateProvinceDesc ?? entry.description ?? entry.hS_DESCRIPTION ?? entry.transactioN_DESC ?? entry.transactionDesc ?? entry.uoM_DESC ?? entry.desc);
      if (code) items.push({ code, description: description || code, payload: entry });
    }
    return { ok: true, items };
  }

  async verifyBuyer(registrationNo: string): Promise<FbrBuyerCheck> {
    const reply = await this.send("POST", paths.registration, { Registration_No: registrationNo.replace(/\D/g, "") });
    const failure = this.failure(reply);
    if (failure) return { ok: false, message: failure.message };
    const answered = reply as { status: number; body: Json | unknown[] | null };
    if (answered.status < 200 || answered.status >= 300) return { ok: false, message: `FBR answered HTTP ${answered.status}` };
    const type = asText(((answered.body ?? {}) as Json).REGISTRATION_TYPE ?? ((answered.body ?? {}) as Json).registrationType);
    if (!type) return { ok: false, message: "FBR did not say whether this number is registered" };
    return { ok: true, registered: /^registered$/i.test(type), message: `FBR lists this number as ${type}` };
  }
}
