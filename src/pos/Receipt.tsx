import { qrcode, drawingSVG } from "bwip-js/browser";
import { createPortal } from "react-dom";
import { useEffect } from "react";
import {
  buildCreditNoteReceipt, buildGoodsReceiptReceipt, buildPaymentReceipt, buildPurchaseBillReceipt, buildPurchaseOrderReceipt, buildPurchaseReturnReceipt, buildQuotationReceipt, buildDeliveryChallanReceipt, buildReceipt, buildSalesOrderReceipt, buildStatementReceipt, buildSupplierPaymentReceipt, receiptPageCss, type PrintFormat, type ReceiptBusiness,
  type ReceiptCreditNote, type ReceiptGoodsReceipt, type ReceiptInvoice, type ReceiptModel, type ReceiptPayment, type ReceiptPurchaseBill, type ReceiptPurchaseOrder, type ReceiptPurchaseReturn, type ReceiptDeliveryChallan, type ReceiptQuotation, type ReceiptSalesOrder, type ReceiptStatement, type ReceiptSupplierPayment,
} from "../../shared/receipt";

type JobBase = {
  format: PrintFormat;
  business: ReceiptBusiness;
  dateFormat: string;
  timezone: string;
  /** Present on a reprint. */
  duplicate?: { copyNumber: number };
};
/** The documents that print, by the name each goes under in a job. */
type Documents = {
  invoice: ReceiptInvoice; payment: ReceiptPayment; creditNote: ReceiptCreditNote; statement: ReceiptStatement;
  purchaseOrder: ReceiptPurchaseOrder; goodsReceipt: ReceiptGoodsReceipt; purchaseBill: ReceiptPurchaseBill;
  supplierPayment: ReceiptSupplierPayment; purchaseReturn: ReceiptPurchaseReturn; quotation: ReceiptQuotation; salesOrder: ReceiptSalesOrder; deliveryChallan: ReceiptDeliveryChallan;
};
type OneDocument<K extends keyof Documents> = { [P in K]: Documents[P] } & { [P in Exclude<keyof Documents, K>]?: undefined };
/** A sale, money received, a credit note, a customer statement, a purchase order or a goods receipt: exactly one of them. */
export type PrintJob = JobBase & { [K in keyof Documents]: OneDocument<K> }[keyof Documents];

export const modelOf = (job: PrintJob) => {
  const options = { business: job.business, dateFormat: job.dateFormat, timezone: job.timezone, duplicate: job.duplicate };
  if (job.creditNote) return buildCreditNoteReceipt(job.creditNote, options);
  if (job.statement) return buildStatementReceipt(job.statement, options);
  if (job.purchaseOrder) return buildPurchaseOrderReceipt(job.purchaseOrder, options);
  if (job.goodsReceipt) return buildGoodsReceiptReceipt(job.goodsReceipt, options);
  if (job.purchaseBill) return buildPurchaseBillReceipt(job.purchaseBill, options);
  if (job.supplierPayment) return buildSupplierPaymentReceipt(job.supplierPayment, options);
  if (job.purchaseReturn) return buildPurchaseReturnReceipt(job.purchaseReturn, options);
  if (job.quotation) return buildQuotationReceipt(job.quotation, options);
  if (job.salesOrder) return buildSalesOrderReceipt(job.salesOrder, options);
  if (job.deliveryChallan) return buildDeliveryChallanReceipt(job.deliveryChallan, options);
  return job.payment ? buildPaymentReceipt(job.payment, options) : buildReceipt(job.invoice, job.format, options);
};

function Rows({ rows }: { rows: ReceiptModel["totals"] }) {
  return <dl className="receipt-rows">{rows.map((row) => <div key={row.label} className={row.strong ? "strong" : undefined}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>;
}

const qrCache = new Map<string, string>();
/** FBR's QR code as an image URL. Drawn through an <img>, never inserted as markup, so nothing in the text can run as script. */
function qrImageUrl(text: string): string {
  const cached = qrCache.get(text);
  if (cached) return cached;
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrcode({ bcid: "qrcode", text, scale: 3, eclevel: "M" }, drawingSVG()))}`;
  qrCache.set(text, url);
  return url;
}

/** Where the document stands with FBR: its invoice number and a QR code to check it by, or a plain note that it has none yet. */
function FbrBlock({ fbr }: { fbr: NonNullable<ReceiptModel["fbr"]> }) {
  return <section className="receipt-fbr" aria-label="FBR">
    {fbr.qrData && <img className="receipt-qr" src={qrImageUrl(fbr.qrData)} alt="FBR invoice QR code" />}
    {fbr.lines.map((line) => <p key={line}>{line}</p>)}
  </section>;
}

/** The document itself. Slips list each item over two lines; sheets use a table. */
export function Receipt({ model, format }: { model: ReceiptModel; format: PrintFormat }) {
  const sheet = format === "a4" || format === "a5";
  return <article className={`receipt receipt-${format}`} aria-label="Receipt">
    {model.duplicateBanner && <p className="receipt-duplicate">{model.duplicateBanner}</p>}
    {model.offlineBanner && <p className="receipt-duplicate" data-testid="receipt-offline">{model.offlineBanner}</p>}
    <header className="receipt-head">
      <h1>{model.businessName}</h1>
      {model.headerLines.map((line) => <p key={line}>{line}</p>)}
      <h2>{model.title}</h2>
    </header>
    <dl className="receipt-meta">
      {model.meta.map((row) => <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}
    </dl>
    {model.lines.length > 0 && (sheet
      ? <table className="receipt-lines">
        <thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Price</th><th className="num">Discount</th><th className="num">Amount</th></tr></thead>
        <tbody>{model.lines.map((line, index) => <tr key={index}>
          <td>{line.name}<small>{line.detail}</small></td><td className="num">{line.quantity}</td><td className="num">{line.unitPrice}</td>
          <td className="num">{line.discount ?? ""}</td><td className="num">{line.total}</td>
        </tr>)}</tbody>
      </table>
      : <ul className="receipt-lines">{model.lines.map((line, index) => <li key={index}>
        <span className="item-name">{line.name}</span>
        <span className="item-figures"><span>{line.unitPrice ? `${line.quantity} × ${line.unitPrice}` : line.quantity}</span><span>{line.total}</span></span>
        {line.discount && <span className="item-figures"><span>discount</span><span>{line.discount}</span></span>}
        <small>{line.detail}</small>
      </li>)}</ul>)}
    {model.statementRows && model.statementRows.length > 0 && (sheet
      ? <table className="receipt-lines">
        <thead><tr><th>Date</th><th>Document</th><th className="num">Debit</th><th className="num">Credit</th><th className="num">Balance</th></tr></thead>
        <tbody>{model.statementRows.map((row, index) => <tr key={index}>
          <td>{row.date}</td><td>{row.document}<small>{row.memo}</small></td><td className="num">{row.debit}</td><td className="num">{row.credit}</td><td className="num">{row.balance}</td>
        </tr>)}</tbody>
      </table>
      : <ul className="receipt-lines">{model.statementRows.map((row, index) => <li key={index}>
        <span className="item-name">{row.date} · {row.document}</span>
        <span className="item-figures"><span>{row.memo} {row.debit ? `+${row.debit}` : `-${row.credit}`}</span><span>{row.balance}</span></span>
      </li>)}</ul>)}
    <Rows rows={model.totals} />
    <Rows rows={model.payments} />
    {model.taxRows.length > 0 && <table className="receipt-tax">
      <thead><tr><th>Tax rate</th><th className="num">Taxable</th><th className="num">Tax</th></tr></thead>
      <tbody>{model.taxRows.map((row) => <tr key={row.rate}><td>{row.rate}</td><td className="num">{row.taxable}</td><td className="num">{row.tax}</td></tr>)}</tbody>
    </table>}
    {model.fbr && <FbrBlock fbr={model.fbr} />}
    <footer className="receipt-foot">{model.footer.map((line) => <p key={line}>{line}</p>)}</footer>
  </article>;
}

/** Prints a job through the browser's print dialog, then lets go of it. The page and the print layout share one document: the print root is hidden on screen and is all that shows when printing. */
export function ReceiptPrinter({ job, onDone }: { job: PrintJob | null; onDone: () => void }) {
  useEffect(() => {
    if (!job) return;
    document.body.classList.add("printing-receipt");
    // Two frames, so the receipt is laid out before the browser takes its picture of the page.
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        window.print();
        onDone();
      });
    });
    return () => {
      document.body.classList.remove("printing-receipt");
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [job, onDone]);

  if (!job) return null;
  return createPortal(<div className="receipt-print-root"><style>{receiptPageCss(job.format)}</style><Receipt model={modelOf(job)} format={job.format} /></div>, document.body);
}
