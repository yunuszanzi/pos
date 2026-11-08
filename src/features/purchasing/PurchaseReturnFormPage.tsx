import { useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { formatPkr } from "../../../shared/money";
import { inputTaxOf } from "../../../shared/purchaseBills";
import { purchaseLineValue } from "../../../shared/purchasing";
import { purchaseReturnSchema } from "../../../shared/schemas/supplierPayments";
import { parseQuantity } from "../../../shared/units";
import { getReturnableReceiptLines, postPurchaseReturn, type ReturnableReceipt } from "../../api/purchasingApi";
import { ErrorMessage, Field, PageTitle, TextInput } from "../../app/FormElements";
import { MoneyInput } from "../../app/MoneyInput";
import { QuantityInput } from "../../app/QuantityInput";
import { amountOf } from "../../pos/amounts";

/** Sends goods from a goods receipt back to the supplier. The credit lowers what the shop owes, and the goods leave stock. */
export function PurchaseReturnFormPage() {
  const [params] = useSearchParams();
  const receiptId = params.get("receipt") ?? "";
  const returnable = useQuery({ queryKey: ["returnable-receipt", receiptId], queryFn: () => getReturnableReceiptLines(receiptId), enabled: Boolean(receiptId), staleTime: 0 });
  if (!receiptId) return <div className="content"><ErrorMessage>Open a goods receipt and choose "Return goods" there.</ErrorMessage><p><Link className="text-button" to="/goods-receipts">Go to goods receipts</Link></p></div>;
  if (returnable.isPending) return <div className="content"><p className="muted">Loading…</p></div>;
  if (returnable.isError) return <div className="content"><ErrorMessage>{returnable.error.message}</ErrorMessage></div>;
  return <ReturnForm data={returnable.data} receiptId={receiptId} />;
}

/** A quantity typed in a box, in thousandths; 0 while it is empty or not a quantity (the form says so on submit). */
function enteredOf(text: string): number {
  try {
    return text ? parseQuantity(text) : 0;
  } catch {
    return 0;
  }
}

/** What is typed for a line. A price that was never touched stays undefined, so the billed price is used. */
type Row = { quantity: string; cost?: string };

function ReturnForm({ data, receiptId }: { data: ReturnableReceipt; receiptId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // One key for this form: a double click or a retry after a dropped connection sends the goods back once.
  const key = useRef(`purchase-return-${crypto.randomUUID()}`);

  const costOf = (lineId: string, fallback: number) => {
    const typed = rows[lineId]?.cost;
    return typed === undefined ? fallback : amountOf(typed);
  };
  const worked = data.lines.map((line) => {
    const quantity = rows[line.id]?.quantity ?? "";
    const entered = enteredOf(quantity);
    const cost = costOf(line.id, line.defaultUnitCostPaisa);
    const valuePaisa = cost === null ? 0 : purchaseLineValue(entered, cost);
    return { line, quantity, entered, cost, valuePaisa, taxPaisa: inputTaxOf(valuePaisa, line.defaultTaxRateBps) };
  });
  const subtotal = worked.reduce((sum, row) => sum + row.valuePaisa, 0);
  const tax = worked.reduce((sum, row) => sum + row.taxPaisa, 0);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const chosen = worked.filter((row) => row.entered > 0);
    if (chosen.some((row) => row.cost === null)) return setError("A price is not a valid amount. Use rupees with up to two decimals");
    const input = {
      receiptId, reason,
      lines: chosen.map((row) => ({
        receiptLineId: row.line.id, quantity: row.quantity.trim(),
        // Only a price the person changed is sent; otherwise the billed price and tax rate are used.
        ...(rows[row.line.id]?.cost !== undefined ? { unitCostPaisa: row.cost! } : {}),
      })),
    };
    const checked = purchaseReturnSchema.safeParse(input);
    if (!checked.success) return setError(checked.error.issues[0].message);
    setBusy(true);
    try {
      const posted = await postPurchaseReturn(input, key.current);
      await Promise.all(["purchase-returns", "suppliers", "supplier-ledger", "supplier-open-bills", "supplier-ageing", "purchase-bills", "purchase-bill", "stock", "returnable-receipt"].map((name) => queryClient.invalidateQueries({ queryKey: [name] })));
      navigate(`/purchase-returns/${posted.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not record the return");
      setBusy(false);
    }
  }

  return <div className="content">
    <PageTitle title={`Return goods from ${data.receipt.number}`} description={`To ${data.receipt.supplierName}. Enter how many of each item go back. The credit is at the billed price and tax unless you change it.`} />
    <form className="stack" onSubmit={(event) => void submit(event)}>
      {error && <ErrorMessage>{error}</ErrorMessage>}
      <section className="panel stack">
        <Field label="Reason"><TextInput value={reason} maxLength={500} placeholder="For example: damaged in transit" onChange={(event) => setReason(event.target.value)} /></Field>
        {worked.map(({ line, valuePaisa }) => {
          const none = parseQuantity(line.returnableQuantity) <= 0;
          return <div className="form-grid" key={line.id} role="group" aria-label={`Line ${line.sku}`}>
            <div><strong>{line.productName}{line.variantName ? ` — ${line.variantName}` : ""}</strong><br /><span className="mono">{line.sku}</span>
              <small className="block muted">{line.returnableQuantity} {line.unitName} can go back · {line.onHandBase} in stock now</small></div>
            <Field label={`Going back (${line.unitName})`}><QuantityInput disabled={none} value={rows[line.id]?.quantity ?? ""} placeholder="0"
              onChange={(event) => setRows({ ...rows, [line.id]: { ...rows[line.id], quantity: event.target.value } })} /></Field>
            <Field label="Credit for one unit (Rs)"><MoneyInput disabled={none} value={rows[line.id]?.cost ?? (line.defaultUnitCostPaisa / 100).toFixed(2)}
              onChange={(event) => setRows({ ...rows, [line.id]: { ...rows[line.id], quantity: rows[line.id]?.quantity ?? "", cost: event.target.value } })} /></Field>
            <div><span className="muted">Value</span><br /><strong>{formatPkr(valuePaisa)}</strong></div>
          </div>;
        })}
        <dl className="totals">
          <div><dt>Goods returned</dt><dd>{formatPkr(subtotal)}</dd></div>
          <div><dt>Input tax reversed</dt><dd>{formatPkr(tax)}</dd></div>
          <div className="grand"><dt>Credit from supplier</dt><dd data-testid="return-credit">{formatPkr(subtotal + tax)}</dd></div>
        </dl>
      </section>
      <div className="button-row">
        <button className="button primary" disabled={busy || subtotal === 0}>{busy ? "Recording…" : "Send goods back"}</button>
        <Link className="button secondary" to={`/goods-receipts/${receiptId}`}>Cancel</Link>
      </div>
    </form>
  </div>;
}
