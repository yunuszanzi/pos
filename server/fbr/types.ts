import type { FbrEnvironment, FbrReferenceKind } from "../../shared/fbr";

// The only way the rest of the system talks to FBR. Every call is server to server; the browser never sees a token or a payload.
// What comes back is already sorted into the four things the caller needs to decide: it worked, FBR refused the data, FBR (or the network)
// was not there and it is worth trying again, or the token itself was refused.

export type FbrRejected = { outcome: "rejected"; code: string; message: string; httpStatus: number; response: unknown };
export type FbrTransient = { outcome: "transient"; message: string; httpStatus?: number; response?: unknown };
export type FbrUnauthorised = { outcome: "unauthorised"; message: string; httpStatus: number; response?: unknown };
export type FbrFailure = FbrRejected | FbrTransient | FbrUnauthorised;

export type FbrValidated = { outcome: "valid"; httpStatus: number; response: unknown } | FbrFailure;
/** `irn` is FBR's number for the invoice; `qrData` is what the QR code on the bill encodes. */
export type FbrPosted = { outcome: "accepted"; irn: string; qrData: string; httpStatus: number; response: unknown } | FbrFailure;

export type FbrReferenceItem = { code: string; description: string; payload: unknown };
export type FbrReferenceResult = { ok: true; items: FbrReferenceItem[] } | { ok: false; message: string };
export type FbrBuyerCheck = { ok: true; registered: boolean; message: string } | { ok: false; message: string };

export interface FbrClient {
  /** "digital-invoicing", "pos-fiscal" or "mock", for the log. */
  readonly name: string;
  /** Asks FBR whether the invoice is acceptable. Changes nothing on FBR's side, so it is safe to repeat. */
  validate(payload: unknown): Promise<FbrValidated>;
  /** Reports the invoice. This is the call that must never be made twice for the same invoice. */
  post(payload: unknown): Promise<FbrPosted>;
  /** Proves FBR is reachable and the token is accepted. */
  testConnection(): Promise<{ ok: boolean; message: string }>;
  fetchReference(kind: FbrReferenceKind): Promise<FbrReferenceResult>;
  /** Whether a buyer's NTN/STRN is registered (FBR's STATL service). */
  verifyBuyer(registrationNo: string): Promise<FbrBuyerCheck>;
}

export type FbrClientSettings = { environment: FbrEnvironment; token: string; timeoutMs: number };
