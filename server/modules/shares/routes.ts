import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { businessSettings, businesses } from "../../../db/schema";
import { auditPrincipal } from "../../lib/audit";
import { db } from "../../lib/db";
import { apiError } from "../../lib/http";
import { getPrincipal, hasPermission } from "../../lib/permissions";
import { validateJson } from "../../lib/validate";
import { loadQuotation } from "../quotations/routes";
import { loadChallan } from "../sales/challans";
import { loadSalesOrder } from "../sales/orders";
import { loadInvoice } from "../sales/routes";

// Sharing a document by link (FR-PRT-07). A share is an unguessable token that lets whoever holds the link READ one document, with no
// sign-in. It expires, can be revoked, never carries costs, and every opening is counted.

export const shareRoutes = new Hono();
export const publicRoutes = new Hono();

const types = ["quotation", "sales_order", "invoice", "delivery_challan"] as const;
type DocType = (typeof types)[number];
/** Who may share a document: whoever may see it. */
const viewPermission: Record<DocType, string> = { quotation: "quotations.view", sales_order: "sales_orders.view", invoice: "invoices.view", delivery_challan: "delivery.view" };
const shareDays = 30;

/** Any signed-in member of a business; what they may share is checked per kind of document. */
const signedIn = async (context: Context, next: () => Promise<void>) => {
  const principal = getPrincipal(context);
  if (!principal.businessId || !principal.activeUserId) return apiError(context, 403, "PERMISSION_DENIED", "You do not have permission to perform this action");
  await next();
};

const shareSchema = z.object({ type: z.enum(types), id: z.string().uuid() });

/** The document as the customer should see it, or null if it does not exist in the business. Costs are never loaded. */
async function loadDocument(type: DocType, businessId: string, id: string) {
  switch (type) {
    case "quotation": return loadQuotation(businessId, id);
    case "sales_order": return loadSalesOrder(businessId, id);
    case "delivery_challan": return loadChallan(businessId, id);
    case "invoice": {
      const invoice = await loadInvoice(businessId, id, false);
      if (!invoice) return null;
      const [row] = await db.execute(sql`
        select i.balance_paisa - coalesce((select sum(x.amount_paisa) from payment_allocations x where x.invoice_id = i.id), 0) as outstanding
        from sales_invoices i where i.id = ${id}`);
      return { ...invoice, outstandingPaisa: Number(row.outstanding) };
    }
  }
}

/** Makes (or reuses) the link for a document. Asking again for a document with a live link returns the same link. */
shareRoutes.post("/document-shares", signedIn, validateJson(shareSchema), async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const { type, id } = context.req.valid("json");
  if (!hasPermission(principal, viewPermission[type])) return apiError(context, 403, "FORBIDDEN", "You may not share this kind of document");
  if (!(await loadDocument(type, businessId, id))) return apiError(context, 404, "NOT_FOUND", "Document not found");

  const [live] = await db.execute<{ token: string; expires_at: string }>(sql`
    select token, expires_at from document_shares
    where business_id = ${businessId} and doc_type = ${type} and doc_id = ${id} and revoked_at is null and expires_at > now() + interval '1 day'
    order by created_at desc limit 1`);
  if (live) return context.json({ token: live.token, path: `/d/${live.token}`, expiresAt: new Date(live.expires_at).toISOString() });

  const token = randomBytes(32).toString("base64url");
  const [created] = await db.execute<{ expires_at: string }>(sql`
    insert into document_shares (business_id, doc_type, doc_id, token, expires_at, created_by)
    values (${businessId}, ${type}, ${id}, ${token}, now() + make_interval(days => ${shareDays}), ${principal.userId})
    returning expires_at`);
  await auditPrincipal(context, principal, type, id, "share", null, { days: shareDays });
  return context.json({ token, path: `/d/${token}`, expiresAt: new Date(created.expires_at).toISOString() }, 201);
});

/** Turns every live link of a document off. */
shareRoutes.post("/document-shares/revoke", signedIn, validateJson(shareSchema), async (context) => {
  const principal = getPrincipal(context);
  const { type, id } = context.req.valid("json");
  if (!hasPermission(principal, viewPermission[type])) return apiError(context, 403, "FORBIDDEN", "You may not manage links for this kind of document");
  const revoked = await db.execute<{ id: string }>(sql`
    update document_shares set revoked_at = now()
    where business_id = ${principal.businessId!} and doc_type = ${type} and doc_id = ${id} and revoked_at is null returning id`);
  if (revoked.length) await auditPrincipal(context, principal, type, id, "unshare", null, { links: revoked.length });
  return context.json({ revoked: revoked.length });
});

/**
 * Opens a shared document. No sign-in: the token is the key. An unknown, expired or revoked token all answer the same 404, so nothing
 * can be learned from trying. Responses are not cached, so a revoked link stops working at once.
 */
publicRoutes.get("/documents/:token", async (context) => {
  context.header("Cache-Control", "no-store");
  context.header("X-Robots-Tag", "noindex");
  const token = context.req.param("token");
  const notFound = () => apiError(context, 404, "NOT_FOUND", "This link is not valid any more. Ask the sender for a new one.");
  if (!/^[A-Za-z0-9_-]{40,100}$/.test(token)) return notFound();

  const [share] = await db.execute<{ id: string; business_id: string; doc_type: DocType; doc_id: string; expires_at: string }>(sql`
    update document_shares set view_count = view_count + 1, last_viewed_at = now()
    where token = ${token} and revoked_at is null and expires_at > now()
    returning id, business_id, doc_type, doc_id, expires_at`);
  if (!share) return notFound();

  const document = await loadDocument(share.doc_type, share.business_id, share.doc_id);
  if (!document) return notFound();
  const [business] = await db.select().from(businesses).where(eq(businesses.id, share.business_id)).limit(1);
  const [settings] = await db.select().from(businessSettings).where(eq(businessSettings.businessId, share.business_id)).limit(1);
  if (!business || !settings) return notFound();
  return context.json({
    type: share.doc_type, document, expiresAt: new Date(share.expires_at).toISOString(),
    business: { tradeName: business.tradeName, legalName: business.legalName, address: business.address, phone: business.phone, ntn: business.ntn, strn: business.strn, receiptFooter: business.receiptFooter },
    dateFormat: settings.dateFormat, timezone: settings.timezone,
  });
});
