import { createHash } from "node:crypto";
import type { FbrReferenceKind } from "../../../shared/fbr";
import type { FbrBuyerCheck, FbrClient, FbrClientSettings, FbrPosted, FbrReferenceResult, FbrValidated } from "../types";

// A stand-in for FBR for development and tests. It behaves like the real thing in the ways that matter, and the token chooses how:
//   mock-ok-token (or any other "mock-" token)  FBR accepts everything and gives each invoice a number worked out from its content
//   mock-down                             FBR cannot be reached (every call times out)
//   mock-auth                             FBR refuses the token
//   mock-reject                           FBR rejects every invoice
// An invoice whose first item has the HS code 0000.0000 is rejected whatever the token. Switching the token switches the behaviour, so a
// browser test can show "FBR down, then back up" without touching the server.
// It is chosen only when the server runs with FBR_ADAPTER=mock; a production server never uses it.

export type MockCall = { kind: "validate" | "post"; token: string; payload: Record<string, unknown> };
/** Every call this process has seen, for tests to count. */
export const mockCalls: MockCall[] = [];
let issuedCount = 0;

const referenceData: Record<FbrReferenceKind, Array<{ code: string; description: string }>> = {
  province: [{ code: "SINDH", description: "SINDH" }, { code: "PUNJAB", description: "PUNJAB" }, { code: "KHYBER PAKHTUNKHWA", description: "KHYBER PAKHTUNKHWA" }, { code: "BALOCHISTAN", description: "BALOCHISTAN" }],
  hs_code: [{ code: "9503.0090", description: "Toys, other" }, { code: "3926.4090", description: "Other articles of plastics" }, { code: "4818.1000", description: "Toilet paper" }],
  uom: [{ code: "Numbers, pieces, units", description: "Numbers, pieces, units" }, { code: "Pack", description: "Pack" }, { code: "Carton", description: "Carton" }, { code: "KG", description: "Kilogram" }],
  sale_type: [{ code: "Goods at standard rate (default)", description: "Goods at standard rate (default)" }, { code: "Goods at Reduced Rate", description: "Goods at Reduced Rate" }, { code: "Exempt goods", description: "Exempt goods" }, { code: "Goods at zero-rate", description: "Goods at zero-rate" }, { code: "3rd Schedule Goods", description: "3rd Schedule Goods" }],
};

export class MockAdapter implements FbrClient {
  readonly name = "mock";
  constructor(private readonly settings: FbrClientSettings) {}

  private get token() { return this.settings.token; }

  private blocked(): FbrValidated | null {
    if (this.token === "mock-down") return { outcome: "transient", message: "FBR could not be reached (mock: down)" };
    if (this.token === "mock-auth") return { outcome: "unauthorised", message: "FBR refused the security token. Check the token in the FBR settings.", httpStatus: 401 };
    return null;
  }

  private refusal(payload: Record<string, unknown>): FbrValidated | null {
    const items = (payload.items as Array<Record<string, unknown>> | undefined) ?? [];
    if (this.token === "mock-reject") return { outcome: "rejected", code: "0099", message: "Mock: FBR rejects every invoice", httpStatus: 200, response: { validationResponse: { statusCode: "01", status: "Invalid", error: "Mock: FBR rejects every invoice" } } };
    if (items[0]?.hsCode === "0000.0000") return { outcome: "rejected", code: "0044", message: "Item 1: Provided HS Code is invalid", httpStatus: 200, response: { validationResponse: { statusCode: "01", status: "Invalid", error: "Provided HS Code is invalid" } } };
    if (!payload.sellerNTNCNIC) return { outcome: "rejected", code: "0001", message: "Seller NTN is required", httpStatus: 200, response: { validationResponse: { statusCode: "01", status: "Invalid", error: "Seller NTN is required" } } };
    return null;
  }

  async validate(payload: unknown): Promise<FbrValidated> {
    mockCalls.push({ kind: "validate", token: this.token, payload: payload as Record<string, unknown> });
    return this.blocked() ?? this.refusal(payload as Record<string, unknown>) ?? { outcome: "valid", httpStatus: 200, response: { validationResponse: { statusCode: "00", status: "Valid", error: "" } } };
  }

  async post(payload: unknown): Promise<FbrPosted> {
    const body = payload as Record<string, unknown>;
    mockCalls.push({ kind: "post", token: this.token, payload: body });
    const stopped = this.blocked() ?? this.refusal(body);
    if (stopped) return stopped as FbrPosted;
    // Every accepted invoice gets a number of its own, as FBR's does: two sales of the same thing on the same day are still two invoices.
    const digest = createHash("sha1").update(JSON.stringify(body)).digest("hex").slice(0, 8).toUpperCase();
    issuedCount += 1;
    const irn = `${String(body.sellerNTNCNIC)}${body.invoiceType === "Debit Note" ? "DN" : "DI"}${digest}${String(issuedCount).padStart(4, "0")}`;
    return { outcome: "accepted", irn, qrData: irn, httpStatus: 200, response: { invoiceNumber: irn, dated: new Date().toISOString(), validationResponse: { statusCode: "00", status: "Valid", error: "" } } };
  }

  async testConnection() {
    const blocked = this.blocked();
    if (blocked) return { ok: false, message: blocked.outcome === "transient" || blocked.outcome === "unauthorised" ? blocked.message : "Mock: not available" };
    return { ok: true, message: `Connected to the mock FBR (${this.settings.environment}). The token was accepted.` };
  }

  async fetchReference(kind: FbrReferenceKind): Promise<FbrReferenceResult> {
    const blocked = this.blocked();
    if (blocked && blocked.outcome !== "valid") return { ok: false, message: (blocked as { message: string }).message };
    return { ok: true, items: referenceData[kind].map((item) => ({ ...item, payload: item })) };
  }

  async verifyBuyer(registrationNo: string): Promise<FbrBuyerCheck> {
    const blocked = this.blocked();
    if (blocked && blocked.outcome !== "valid") return { ok: false, message: (blocked as { message: string }).message };
    // Numbers ending in 0 are unregistered in the mock, so both answers can be tested.
    const registered = !registrationNo.replace(/\D/g, "").endsWith("0");
    return { ok: true, registered, message: registered ? "Mock: FBR lists this number as Registered" : "Mock: FBR lists this number as Unregistered" };
  }
}
