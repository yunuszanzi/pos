import { postJson } from "./client";

export type ShareType = "quotation" | "sales_order" | "invoice" | "delivery_challan";
export type DocumentShare = { token: string; path: string; expiresAt: string };

/** The link for a document: a live one is reused, otherwise a new one is made. */
export const createDocumentShare = (type: ShareType, id: string) => postJson<DocumentShare>("/document-shares", { type, id });
/** Turns every live link of a document off. */
export const revokeDocumentShares = (type: ShareType, id: string) => postJson<{ revoked: number }>("/document-shares/revoke", { type, id });

/** What a link opens: the document as it prints, and the business that issued it. No sign-in is involved, so this does not use the signed-in client. */
export type PublicDocument = {
  type: ShareType;
  document: unknown;
  expiresAt: string;
  business: { tradeName: string; legalName: string; address: string; phone: string; ntn: string | null; strn: string | null; receiptFooter: string };
  dateFormat: string;
  timezone: string;
};

export async function getPublicDocument(token: string, signal?: AbortSignal): Promise<PublicDocument> {
  const response = await fetch(`/api/public/documents/${encodeURIComponent(token)}`, { signal });
  const body = await response.json().catch(() => null) as (PublicDocument & { error?: { message?: string } }) | null;
  if (!response.ok || !body) throw new Error(body?.error?.message ?? "This link could not be opened. Try again, or ask the sender for a new one.");
  return body;
}
