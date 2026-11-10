import { businessToday } from "../../../shared/dates";
import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { formatBps, formatPkr, parsePercentToBps, toPlainRupees } from "../../../shared/money";
import { discountPercentBps, priceCart } from "../../../shared/pricing";
import { quotationSchema } from "../../../shared/schemas/quotations";
import { parseQuantity } from "../../../shared/units";
import { getAllUnits } from "../../api/catalogueApi";
import type { Product, ProductVariant } from "../../api/productsApi";
import { createQuotation, getQuotationById, updateQuotation, type Quotation } from "../../api/quotationsApi";
import { ErrorMessage, Field, PageTitle, SelectInput, TextInput } from "../../app/FormElements";
import { MoneyInput } from "../../app/MoneyInput";
import { QuantityInput } from "../../app/QuantityInput";
import { amountOf } from "../../pos/amounts";
import { CustomerPicker, type PickedCustomer } from "../customers/CustomerPicker";
import { ProductPicker } from "../products/ProductPicker";

type UnitChoice = { unitId: string; name: string; salePricePaisa: number };
type Line = {
  variantId: string; sku: string; productName: string; variantName: string;
  unitId: string; units: UnitChoice[]; quantity: string;
  /** Empty = the shelf price, or the customer's tier price, worked out when the quotation is saved. */
  price: string;
  /** A percentage off this line, e.g. 5 or 7.5. */
  discount: string;
};

const inDays = (days: number) => new Date(Date.parse(businessToday()) + days * 86_400_000).toISOString().slice(0, 10);

/** Writes a quotation, or changes one that is still a draft. */
export function QuotationFormPage() {
  const { id } = useParams();
  const existing = useQuery({ queryKey: ["quotation", id], queryFn: () => getQuotationById(id!), enabled: Boolean(id), staleTime: 0 });
  if (id && existing.isPending) return <div className="content"><p className="muted">Loading…</p></div>;
  if (id && existing.isError) return <div className="content"><ErrorMessage>{existing.error.message}</ErrorMessage></div>;
  if (existing.data && existing.data.storedStatus !== "draft") return <div className="content"><ErrorMessage>Only a draft can be changed. Revise the quotation to change one that was sent.</ErrorMessage></div>;
  return <QuotationForm quotation={existing.data} />;
}

function QuotationForm({ quotation }: { quotation?: Quotation }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const units = useQuery({ queryKey: ["units"], queryFn: getAllUnits, staleTime: 5 * 60_000 });
  const [customer, setCustomer] = useState<PickedCustomer | null>(quotation?.customerId ? { id: quotation.customerId, name: quotation.customerName, phone: quotation.customerPhone } : null);
  const [prospectName, setProspectName] = useState(quotation?.isProspect ? quotation.customerName : "");
  const [prospectPhone, setProspectPhone] = useState(quotation?.isProspect ? quotation.customerPhone : "");
  const [validUntil, setValidUntil] = useState(quotation?.validUntil ?? inDays(14));
  const [terms, setTerms] = useState(quotation?.terms ?? "");
  const [note, setNote] = useState(quotation?.note ?? "");
  const [lines, setLines] = useState<Line[]>(() => (quotation?.lines ?? []).map((line) => ({
    variantId: line.variantId, sku: line.sku, productName: line.productName, variantName: line.variantName, unitId: line.unitId,
    // A line already written keeps its unit and its price; to quote another unit, remove the line and add it again.
    units: [{ unitId: line.unitId, name: line.unitName, salePricePaisa: line.unitPricePaisa }], quantity: line.quantity,
    price: toPlainRupees(line.unitPricePaisa), discount: line.lineDiscountPaisa > 0 ? percentOf(line.lineDiscountPaisa, line.grossPaisa) : "",
  })));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const unitName = (unitId: string) => units.data?.find((unit) => unit.id === unitId)?.name ?? "";

  function addLine(product: Product, variant: ProductVariant) {
    if (lines.some((line) => line.variantId === variant.id)) return;
    const choices = variant.units.map((unit) => ({ unitId: unit.unitId, name: unitName(unit.unitId), salePricePaisa: unit.salePricePaisa }));
    const first = choices.find((choice) => variant.units.find((unit) => unit.unitId === choice.unitId)?.isBase) ?? choices[0];
    setLines([...lines, { variantId: variant.id, sku: variant.sku, productName: product.name, variantName: variant.variantName, unitId: first.unitId, units: choices, quantity: "", price: "", discount: "" }]);
  }
  const change = (index: number, patch: Partial<Line>) => setLines(lines.map((line, position) => (position === index ? { ...line, ...patch } : line)));

  /** An estimate at the price typed or the shelf price; the server works out the real figure (tier, tax) when it saves. */
  const estimate = (line: Line) => {
    try {
      const price = line.price ? amountOf(line.price) : line.units.find((unit) => unit.unitId === line.unitId)?.salePricePaisa ?? 0;
      if (price === null || !line.quantity) return 0;
      const discount = line.discount ? { type: "percent" as const, bps: parsePercentToBps(line.discount) } : null;
      return priceCart({ taxMode: "exclusive", lines: [{ qtyMilli: parseQuantity(line.quantity), unitPricePaisa: price, taxRateBps: 0, discount }] }).totalPaisa;
    } catch {
      return 0;
    }
  };
  const subtotal = lines.reduce((sum, line) => sum + estimate(line), 0);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const prices = lines.map((line) => (line.price ? amountOf(line.price) : undefined));
    if (prices.some((value) => value === null)) return setError("A price is not a valid amount. Use rupees with up to two decimals, for example 3200.00");
    let discounts;
    try {
      discounts = lines.map((line) => (line.discount ? { type: "percent" as const, bps: parsePercentToBps(line.discount) } : null));
    } catch {
      return setError("A discount must be a percentage between 0 and 100, for example 5 or 7.5");
    }
    const input = {
      customerId: customer?.id ?? null, prospectName: customer ? "" : prospectName, prospectPhone: customer ? "" : prospectPhone, validUntil, terms, note,
      lines: lines.map((line, index) => ({
        variantId: line.variantId, unitId: line.unitId, quantity: line.quantity.trim(),
        ...(prices[index] !== undefined ? { unitPricePaisa: prices[index]! } : {}), discount: discounts[index],
      })),
    };
    const checked = quotationSchema.safeParse(input);
    if (!checked.success) {
      const [issue] = checked.error.issues;
      const line = issue.path[0] === "lines" && typeof issue.path[1] === "number" ? lines[issue.path[1]] : undefined;
      return setError(`${line ? `${line.sku}: ` : ""}${issue.message}`);
    }
    setBusy(true);
    try {
      const saved = quotation ? await updateQuotation(quotation.id, input) : await createQuotation(input);
      await Promise.all(["quotations", "quotation"].map((name) => queryClient.invalidateQueries({ queryKey: [name] })));
      navigate(`/quotations/${saved.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the quotation");
      setBusy(false);
    }
  }

  return <div className="content">
    <PageTitle title={quotation ? `Change ${quotation.number}${quotation.revisionNo > 1 ? ` Rev ${quotation.revisionNo}` : ""}` : "New quotation"}
      description="Choose the customer (or type a prospect's name), add the items and say how long the offer stands. It stays a draft until you send it." />
    <form className="stack" onSubmit={(event) => void submit(event)}>
      {error && <ErrorMessage>{error}</ErrorMessage>}
      <section className="panel stack">
        <div className="form-grid">
          <CustomerPicker value={customer} onChange={setCustomer} />
          {!customer && <>
            <Field label="Or a prospect's name"><TextInput value={prospectName} maxLength={200} onChange={(event) => setProspectName(event.target.value)} /></Field>
            <Field label="Prospect's phone"><TextInput value={prospectPhone} maxLength={20} inputMode="tel" onChange={(event) => setProspectPhone(event.target.value)} /></Field>
          </>}
          <Field label="Valid until"><TextInput type="date" value={validUntil} onChange={(event) => setValidUntil(event.target.value)} required /></Field>
          <Field label="Terms"><TextInput value={terms} maxLength={2000} placeholder="For example 50% advance, delivery in 3 days" onChange={(event) => setTerms(event.target.value)} /></Field>
          <Field label="Note"><TextInput value={note} maxLength={1000} onChange={(event) => setNote(event.target.value)} /></Field>
        </div>
      </section>
      <section className="panel stack">
        <h2>Items</h2>
        <ProductPicker isPicked={(variantId) => lines.some((line) => line.variantId === variantId)} onPick={addLine} />
        {lines.map((line, index) => <div className="form-grid" key={line.variantId} role="group" aria-label={`Line ${line.sku}`}>
          <div><strong>{line.productName}{line.variantName ? ` — ${line.variantName}` : ""}</strong><br /><span className="mono">{line.sku}</span></div>
          <Field label="Quantity"><QuantityInput value={line.quantity} onChange={(event) => change(index, { quantity: event.target.value })} placeholder="0" required /></Field>
          <Field label="Unit"><SelectInput value={line.unitId} onChange={(event) => change(index, { unitId: event.target.value })}>{line.units.map((unit) => <option key={unit.unitId} value={unit.unitId}>{unit.name}</option>)}</SelectInput></Field>
          <Field label="Price of one unit (Rs)"><MoneyInput value={line.price} placeholder={toPlainRupees(line.units.find((unit) => unit.unitId === line.unitId)?.salePricePaisa ?? 0)} onChange={(event) => change(index, { price: event.target.value })} /></Field>
          <Field label="Discount (%)"><QuantityInput value={line.discount} onChange={(event) => change(index, { discount: event.target.value })} placeholder="0" /></Field>
          <div><span className="muted">About</span><br /><strong>{formatPkr(estimate(line))}</strong></div>
          <button className="text-button" type="button" onClick={() => setLines(lines.filter((_, position) => position !== index))}>Remove line</button>
        </div>)}
        {!lines.length && <p className="muted">No items added yet.</p>}
        {lines.length > 0 && <>
          <p className="pay-total"><span>Items, about</span><strong data-testid="quotation-estimate">{formatPkr(subtotal)}</strong></p>
          <p className="muted">Leave a price empty to quote the shelf price (or the customer's price tier). Tax and the exact total are worked out when you save.</p>
        </>}
      </section>
      <div className="button-row">
        <button className="button primary" disabled={busy || !lines.length || (!customer && !prospectName.trim())}>{busy ? "Saving…" : "Save quotation"}</button>
        <Link className="button secondary" to={quotation ? `/quotations/${quotation.id}` : "/quotations"}>Cancel</Link>
      </div>
    </form>
  </div>;
}

/** 500 of 5000 -> "10"; the percentage a discount was, to show it again when a draft is reopened. */
function percentOf(discountPaisa: number, grossPaisa: number): string {
  return grossPaisa > 0 ? formatBps(discountPercentBps({ type: "fixed", paisa: discountPaisa }, grossPaisa)) : "";
}
