import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { whatsappLink, whatsappShareLink } from "../../../shared/khata";
import { formatBps, formatPkr } from "../../../shared/money";
import { quotationShareMessage, quotationStatusLabels } from "../../../shared/quotations";
import { formatDay, printFormatLabels, printFormats, type PrintFormat } from "../../../shared/receipt";
import { getQuotationById, moveQuotation, type Quotation, type QuotationMove } from "../../api/quotationsApi";
import { ErrorMessage, PageTitle, SelectInput, SuccessMessage } from "../../app/FormElements";
import { useCan } from "../../app/permissions";
import { ReceiptPrinter, type PrintJob } from "../../pos/Receipt";
import { dayText } from "../purchasing/dayText";
import { usePrintSetup } from "../purchasing/usePrintSetup";

const moves: Record<QuotationMove, { label: string; done: string }> = {
  send: { label: "Mark as sent", done: "marked as sent" },
  accept: { label: "Customer accepted", done: "accepted" },
  reject: { label: "Customer declined", done: "marked as declined" },
  revise: { label: "Revise (new revision)", done: "revised" },
};

/** One quotation: what was offered, to whom, until when, and what can be done with it next. */
export function QuotationPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const mayManage = useCan("quotations.manage");
  const setup = usePrintSetup();
  const [format, setFormat] = useState<PrintFormat | "">("");
  const [job, setJob] = useState<PrintJob | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  // One key per kind of move on this quotation, so pressing twice cannot do it twice.
  const keys = useRef(new Map<QuotationMove, string>());
  const found = useQuery({ queryKey: ["quotation", id], queryFn: () => getQuotationById(id), staleTime: 0 });

  if (found.isPending) return <div className="content"><p className="muted">Loading…</p></div>;
  if (found.isError) return <div className="content"><ErrorMessage>{found.error.message}</ErrorMessage></div>;
  const data: Quotation = found.data;
  const label = `${data.number}${data.revisionNo > 1 ? ` Rev ${data.revisionNo}` : ""}`;
  const can = (move: QuotationMove) => mayManage && (
    (move === "send" && data.status === "draft")
    || (move === "accept" && data.status === "sent")
    || (move === "reject" && (data.status === "sent" || data.status === "accepted"))
    // An expired quotation is revised to give it a new date.
    || (move === "revise" && ["sent", "accepted", "rejected", "expired"].includes(data.status)));

  async function move(action: QuotationMove) {
    setBusy(true);
    setError("");
    setNotice("");
    if (!keys.current.has(action)) keys.current.set(action, `quo-${action}-${crypto.randomUUID()}`);
    try {
      const result = await moveQuotation(id, action, keys.current.get(action)!);
      await Promise.all(["quotation", "quotations"].map((name) => queryClient.invalidateQueries({ queryKey: [name] })));
      if (action === "revise") return navigate(`/quotations/${result.id}/edit`);
      setNotice(`${label} ${moves[action].done}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update the quotation");
    } finally {
      setBusy(false);
    }
  }

  function print() {
    if (!setup) return;
    setJob({
      business: setup.business, dateFormat: setup.dateFormat, timezone: setup.timezone, format: format || setup.defaultFormat,
      quotation: {
        number: data.number, revisionNo: data.revisionNo, quoteDate: data.quoteDate, validUntil: data.validUntil, branchName: data.branchName,
        customerName: data.customerName, customerPhone: data.customerPhone, customerNtn: data.customerNtn, customerStrn: data.customerStrn,
        terms: data.terms, note: data.note, taxMode: data.taxMode, grossPaisa: data.grossPaisa, lineDiscountPaisa: data.lineDiscountPaisa,
        invoiceDiscountPaisa: data.invoiceDiscountPaisa, taxPaisa: data.taxPaisa, roundingPaisa: data.roundingPaisa, totalPaisa: data.totalPaisa,
        lines: data.lines.map((line) => ({
          productName: line.productName, variantName: line.variantName, sku: line.sku, unitName: line.unitName, quantity: line.quantity, unitPricePaisa: line.unitPricePaisa,
          lineDiscountPaisa: line.lineDiscountPaisa, invoiceDiscountSharePaisa: line.invoiceDiscountSharePaisa, taxRateBps: line.taxRateBps, taxPaisa: line.taxPaisa, totalPaisa: line.totalPaisa,
        })),
      },
    });
  }

  const message = quotationShareMessage({
    businessName: setup?.business.tradeName ?? "", number: label, customerName: data.customerName, totalText: formatPkr(data.totalPaisa),
    validUntilText: formatDay(data.validUntil, setup?.dateFormat ?? "dd/MM/yyyy"),
  });
  // To the customer's own number when there is one, else WhatsApp lets the person choose who.
  const shareLink = (data.customerPhone && whatsappLink(data.customerPhone, message)) || whatsappShareLink(message);
  const mayShare = data.status !== "draft" && data.status !== "revised";

  return <div className="content">
    <PageTitle title={`${label} — ${quotationStatusLabels[data.status]}`} description={`For ${data.customerName}${data.isProspect ? " (prospect)" : ""}, valid until ${dayText(data.validUntil)}.`} />
    <p><Link className="text-button" to="/quotations">← Back to quotations</Link></p>
    {error && <ErrorMessage>{error}</ErrorMessage>}
    {notice && <SuccessMessage>{notice}</SuccessMessage>}
    {data.status === "revised" && data.supersededBy && <ErrorMessage>A newer revision replaced this one. <Link className="text-button" to={`/quotations/${data.supersededBy}`}>Open the newer revision</Link></ErrorMessage>}
    {data.status === "expired" && <ErrorMessage>This quotation expired on {dayText(data.validUntil)}. Revise it to give it a new date.</ErrorMessage>}
    <section className="panel stack">
      <dl className="totals">
        <div><dt>For</dt><dd>{data.customerName}{data.customerPhone ? ` · ${data.customerPhone}` : ""}</dd></div>
        <div><dt>Dated</dt><dd>{dayText(data.quoteDate)}</dd></div>
        <div><dt>Valid until</dt><dd>{dayText(data.validUntil)}</dd></div>
        <div><dt>Subtotal</dt><dd>{formatPkr(data.grossPaisa)}</dd></div>
        {data.lineDiscountPaisa + data.invoiceDiscountPaisa > 0 && <div><dt>Discounts</dt><dd>-{formatPkr(data.lineDiscountPaisa + data.invoiceDiscountPaisa)}</dd></div>}
        <div><dt>{data.taxMode === "inclusive" ? "Tax (included)" : "Tax"}</dt><dd>{formatPkr(data.taxPaisa)}</dd></div>
        <div className="grand"><dt>Quoted total</dt><dd data-testid="quotation-total">{formatPkr(data.totalPaisa)}</dd></div>
      </dl>
      {data.terms && <p><strong>Terms:</strong> {data.terms}</p>}
      {data.note && <p className="muted">{data.note}</p>}
      <div className="button-row">
        {mayManage && data.status === "draft" && <Link className="button secondary" to={`/quotations/${data.id}/edit`}>Change quotation</Link>}
        {can("send") && <button className="button primary" disabled={busy} onClick={() => void move("send")}>{moves.send.label}</button>}
        {can("accept") && <button className="button primary" disabled={busy} onClick={() => void move("accept")}>{moves.accept.label}</button>}
        {can("reject") && <button className="button secondary" disabled={busy} onClick={() => void move("reject")}>{moves.reject.label}</button>}
        {can("revise") && <button className="button secondary" disabled={busy} onClick={() => void move("revise")}>{moves.revise.label}</button>}
        {mayShare && <a className="button secondary" href={shareLink} target="_blank" rel="noreferrer">Share on WhatsApp</a>}
      </div>
      {setup && <div className="pay-row">
        <SelectInput aria-label="Print format" value={format || setup.defaultFormat} onChange={(event) => setFormat(event.target.value as PrintFormat)}>
          {printFormats.map((value) => <option key={value} value={value}>{printFormatLabels[value]}</option>)}
        </SelectInput>
        <button className="button secondary" onClick={print}>Print quotation</button>
      </div>}
    </section>

    <section className="panel stack">
      <h2>Items</h2>
      <div className="table-scroll"><table aria-label="Quotation items">
        <thead><tr><th>Item</th><th>Unit</th><th className="num">Quantity</th><th className="num">Price</th><th className="num">Discount</th><th className="num">Tax</th><th className="num">Total</th></tr></thead>
        <tbody>
          {data.lines.map((line) => <tr key={line.id}>
            <td>{line.productName}{line.variantName ? ` — ${line.variantName}` : ""}<small className="block muted">{line.sku}</small></td>
            <td>{line.unitName}</td><td className="num">{line.quantity}</td><td className="num">{formatPkr(line.unitPricePaisa)}</td>
            <td className="num">{line.lineDiscountPaisa + line.invoiceDiscountSharePaisa > 0 ? `-${formatPkr(line.lineDiscountPaisa + line.invoiceDiscountSharePaisa)}` : ""}</td>
            <td className="num">{line.taxRateBps ? `${formatBps(line.taxRateBps)}% · ${formatPkr(line.taxPaisa)}` : ""}</td>
            <td className="num">{formatPkr(line.totalPaisa)}</td>
          </tr>)}
        </tbody>
      </table></div>
    </section>

    {data.revisions.length > 1 && <section className="panel stack">
      <h2>Revisions</h2>
      <div className="table-scroll"><table aria-label="Revisions">
        <thead><tr><th>Revision</th><th>Status</th><th className="num">Total</th></tr></thead>
        <tbody>{data.revisions.map((revision) => <tr key={revision.id}>
          <td>{revision.id === data.id ? `Rev ${revision.revisionNo} (this one)` : <Link className="text-button" to={`/quotations/${revision.id}`}>Rev {revision.revisionNo}</Link>}</td>
          <td>{quotationStatusLabels[revision.status]}</td><td className="num">{formatPkr(revision.totalPaisa)}</td>
        </tr>)}</tbody>
      </table></div>
    </section>}
    <ReceiptPrinter job={job} onDone={() => setJob(null)} />
  </div>;
}
