import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import { formatDay } from "../../../shared/receipt";
import type { Challan } from "../../api/deliveryApi";
import type { Quotation } from "../../api/quotationsApi";
import type { Invoice } from "../../api/salesInvoicesApi";
import type { SalesOrder } from "../../api/salesOrdersApi";
import { getPublicDocument, type PublicDocument } from "../../api/sharesApi";
import { challanPrintDoc, invoicePrintDoc, quotationPrintDoc, salesOrderPrintDoc } from "../../pos/documentPrint";
import { modelOf, Receipt, ReceiptPrinter, type PrintJob } from "../../pos/Receipt";

/** The job that prints (and so shows) a shared document, whichever kind it is. */
function jobOf(shared: PublicDocument): PrintJob {
  const base = { business: shared.business, dateFormat: shared.dateFormat, timezone: shared.timezone, format: "a4" as const };
  switch (shared.type) {
    case "quotation": return { ...base, quotation: quotationPrintDoc(shared.document as Quotation) };
    case "sales_order": return { ...base, salesOrder: salesOrderPrintDoc(shared.document as SalesOrder) };
    case "delivery_challan": return { ...base, deliveryChallan: challanPrintDoc(shared.document as Challan) };
    case "invoice": return { ...base, invoice: invoicePrintDoc(shared.document as Invoice) };
  }
}

/**
 * What a customer sees when they open a shared link on their phone: the document exactly as it prints, with no sign-in and no menu.
 * "Print or save as PDF" uses the browser's own print dialog, which on a phone offers saving a PDF.
 */
export function PublicDocumentPage() {
  const token = useLocation().pathname.replace(/^\/d\//, "").replace(/\/.*$/, "");
  const [job, setJob] = useState<PrintJob | null>(null);
  const found = useQuery({ queryKey: ["public-document", token], queryFn: ({ signal }) => getPublicDocument(token, signal), retry: false, staleTime: 60_000 });

  // A shared link is for the person it was sent to, not for search engines.
  useEffect(() => {
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex";
    document.head.appendChild(meta);
    return () => { meta.remove(); };
  }, []);

  if (found.isPending) return <main className="public-document"><p className="muted">Opening the document…</p></main>;
  if (found.isError) return <main className="public-document"><section className="public-sheet"><h1>This link does not work</h1><p>{found.error.message}</p></section></main>;
  const shared = found.data;
  const shown = jobOf(shared);
  return <main className="public-document">
    <section className="public-sheet" aria-label="Shared document"><Receipt model={modelOf(shown)} format="a4" /></section>
    <div className="public-actions">
      <button className="button primary" onClick={() => setJob(shown)}>Print or save as PDF</button>
      <p className="muted">This link works until {formatDay(shared.expiresAt.slice(0, 10), shared.dateFormat)}.</p>
    </div>
    <ReceiptPrinter job={job} onDone={() => setJob(null)} />
  </main>;
}
