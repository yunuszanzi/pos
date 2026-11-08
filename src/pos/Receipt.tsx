import { createPortal } from "react-dom";
import { useEffect } from "react";
import {
  buildCreditNoteReceipt, buildPaymentReceipt, buildReceipt, receiptPageCss, type PrintFormat, type ReceiptBusiness, type ReceiptCreditNote, type ReceiptInvoice, type ReceiptModel, type ReceiptPayment,
} from "../../shared/receipt";

type JobBase = {
  format: PrintFormat;
  business: ReceiptBusiness;
  dateFormat: string;
  timezone: string;
  /** Present on a reprint. */
  duplicate?: { copyNumber: number };
};
/** A sale, money received from a customer, or a credit note for goods taken back. */
export type PrintJob = JobBase & (
  { invoice: ReceiptInvoice; payment?: undefined; creditNote?: undefined }
  | { payment: ReceiptPayment; invoice?: undefined; creditNote?: undefined }
  | { creditNote: ReceiptCreditNote; invoice?: undefined; payment?: undefined }
);

const modelOf = (job: PrintJob) => {
  const options = { business: job.business, dateFormat: job.dateFormat, timezone: job.timezone, duplicate: job.duplicate };
  if (job.creditNote) return buildCreditNoteReceipt(job.creditNote, options);
  return job.payment ? buildPaymentReceipt(job.payment, options) : buildReceipt(job.invoice, job.format, options);
};

function Rows({ rows }: { rows: ReceiptModel["totals"] }) {
  return <dl className="receipt-rows">{rows.map((row) => <div key={row.label} className={row.strong ? "strong" : undefined}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>;
}

/** The document itself. Slips list each item over two lines; sheets use a table. */
export function Receipt({ model, format }: { model: ReceiptModel; format: PrintFormat }) {
  const sheet = format === "a4" || format === "a5";
  return <article className={`receipt receipt-${format}`} aria-label="Receipt">
    {model.duplicateBanner && <p className="receipt-duplicate">{model.duplicateBanner}</p>}
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
        <span className="item-figures"><span>{line.quantity} × {line.unitPrice}</span><span>{line.total}</span></span>
        {line.discount && <span className="item-figures"><span>discount</span><span>{line.discount}</span></span>}
        <small>{line.detail}</small>
      </li>)}</ul>)}
    <Rows rows={model.totals} />
    <Rows rows={model.payments} />
    {model.taxRows.length > 0 && <table className="receipt-tax">
      <thead><tr><th>Tax rate</th><th className="num">Taxable</th><th className="num">Tax</th></tr></thead>
      <tbody>{model.taxRows.map((row) => <tr key={row.rate}><td>{row.rate}</td><td className="num">{row.taxable}</td><td className="num">{row.tax}</td></tr>)}</tbody>
    </table>}
    <footer className="receipt-foot">{model.footer.map((line) => <p key={line}>{line}</p>)}</footer>
  </article>;
}

/** Prints a job through the browser's print dialog, then lets go of it. The page and the print layout share one document: the print root is hidden on screen and is all that shows when printing. */
export function ReceiptPrinter({ job, onDone }: { job: PrintJob | null; onDone: () => void }) {
  useEffect(() => {
    if (!job) return;
    // Two frames, so the receipt is laid out before the browser takes its picture of the page.
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        window.print();
        onDone();
      });
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [job, onDone]);

  if (!job) return null;
  return createPortal(<div className="receipt-print-root"><style>{receiptPageCss(job.format)}</style><Receipt model={modelOf(job)} format={job.format} /></div>, document.body);
}
