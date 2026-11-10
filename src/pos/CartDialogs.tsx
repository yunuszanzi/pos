import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatBps, formatPkr, parsePercentToBps, toPlainRupees } from "../../shared/money";
import type { Discount } from "../../shared/pricing";
import { formatQuantity, parseQuantity } from "../../shared/units";
import { QuantityInput } from "../app/QuantityInput";
import { NetworkError } from "../api/client";
import { discardHeldSale, getAllHeldSales, logVoidedSale, recallHeldSale } from "../api/posApi";
import { ErrorMessage, Field, SelectInput, TextInput } from "../app/FormElements";
import { MoneyInput } from "../app/MoneyInput";
import { amountOf } from "./amounts";
import type { PriceListItem } from "../../shared/priceLists";
import { parseStoredCart, unitPriceOf, type Cart, type CartLine } from "./cart";
import { Dialog } from "./Dialog";
import { usePos } from "./pos-context";

/** A discount typed as a percentage or a fixed amount. Returns null for "no discount" and undefined while the text is not valid. */
function readDiscount(kind: "percent" | "fixed", text: string): Discount | null | undefined {
  if (!text.trim()) return null;
  try {
    if (kind === "percent") {
      const bps = parsePercentToBps(text);
      return bps === 0 ? null : { type: "percent", bps };
    }
    const paisa = amountOf(text);
    if (paisa === null) return undefined;
    return paisa === 0 ? null : { type: "fixed", paisa };
  } catch {
    return undefined;
  }
}

const discountText = (discount: Discount | null) => (!discount ? "" : discount.type === "percent" ? formatBps(discount.bps) : toPlainRupees(discount.paisa));

function DiscountFields({ kind, text, onKind, onText }: { kind: "percent" | "fixed"; text: string; onKind: (kind: "percent" | "fixed") => void; onText: (text: string) => void }) {
  return <div className="pay-row">
    <SelectInput aria-label="Discount type" value={kind} onChange={(event) => onKind(event.target.value as "percent" | "fixed")}>
      <option value="percent">Percent (%)</option><option value="fixed">Amount (Rs)</option>
    </SelectInput>
    {kind === "fixed"
      ? <MoneyInput aria-label="Discount" value={text} onChange={(event) => onText(event.target.value)} />
      : <TextInput aria-label="Discount" inputMode="decimal" value={text} onChange={(event) => onText(event.target.value)} placeholder="0" />}
  </div>;
}

export function BillDiscountDialog({ current, onClose, onApply }: { current: Discount | null; onClose: () => void; onApply: (discount: Discount | null) => void }) {
  const [kind, setKind] = useState<"percent" | "fixed">(current?.type ?? "percent");
  const [text, setText] = useState(discountText(current));
  const [error, setError] = useState("");
  function submit(event: FormEvent) {
    event.preventDefault();
    const discount = readDiscount(kind, text);
    if (discount === undefined) return setError(kind === "percent" ? "Enter a percentage such as 5 or 7.5" : "Enter rupees such as 250.00");
    onApply(discount);
  }
  return <Dialog title="Bill discount" onClose={onClose}><form className="stack" onSubmit={submit}>
    <DiscountFields kind={kind} text={text} onKind={setKind} onText={setText} />
    <p className="muted">Leave empty to remove the discount.</p>
    {error && <ErrorMessage>{error}</ErrorMessage>}
    <button className="button primary">Apply</button>
  </form></Dialog>;
}

export function LineDialog({ line, tier, onClose, onApply, onRemove }: {
  line: CartLine; /** The customer's price list items, empty for a walk-in. */ tier: readonly PriceListItem[]; onClose: () => void; onApply: (change: Partial<Omit<CartLine, "key" | "variantId">>) => void; onRemove: () => void;
}) {
  const { catalogue, can } = usePos();
  const units = catalogue.unitsOf(line.variantId);
  const entry = catalogue.get(line.variantId, line.unitId);
  const [unitId, setUnitId] = useState(line.unitId);
  const [quantity, setQuantity] = useState(formatQuantity(line.quantityMilli));
  const [price, setPrice] = useState(toPlainRupees(entry ? unitPriceOf(line, entry, tier) : 0));
  const [kind, setKind] = useState<"percent" | "fixed">(line.discount?.type ?? "percent");
  const [discount, setDiscount] = useState(discountText(line.discount));
  const [error, setError] = useState("");

  function submit(event: FormEvent) {
    event.preventDefault();
    let quantityMilli: number;
    try {
      quantityMilli = parseQuantity(quantity);
    } catch {
      return setError("Enter a quantity such as 2 or 1.5");
    }
    if (quantityMilli <= 0) return setError("The quantity must be more than zero");
    const read = readDiscount(kind, discount);
    if (read === undefined) return setError(kind === "percent" ? "Enter a percentage such as 5 or 7.5" : "Enter rupees such as 250.00");
    const chosen = catalogue.get(line.variantId, unitId);
    const typed = amountOf(price);
    if (typed === null) return setError("Enter the price as rupees");
    // Only a price that differs from what the customer would be charged anyway (shelf or tier, for this quantity) is an override.
    const normal = chosen ? unitPriceOf({ variantId: line.variantId, unitId, quantityMilli, priceOverridePaisa: null }, chosen, tier) : typed;
    const priceOverridePaisa = chosen && typed !== normal ? typed : null;
    onApply({ unitId, quantityMilli, discount: read, priceOverridePaisa });
  }

  return <Dialog title={entry ? `${entry.productName}${entry.variantName ? ` — ${entry.variantName}` : ""}` : "Item"} onClose={onClose}><form className="stack" onSubmit={submit}>
    <div className="form-grid">
      <Field label="Quantity"><QuantityInput value={quantity} autoFocus onFocus={(event) => event.currentTarget.select()} onChange={(event) => setQuantity(event.target.value)} /></Field>
      <Field label="Unit"><SelectInput value={unitId} onChange={(event) => {
        setUnitId(event.target.value);
        const next = catalogue.get(line.variantId, event.target.value);
        setPrice(toPlainRupees(next ? unitPriceOf({ variantId: line.variantId, unitId: event.target.value, quantityMilli: line.quantityMilli, priceOverridePaisa: null }, next, tier) : 0));
      }}>{units.map((unit) => <option key={unit.unitId} value={unit.unitId}>{unit.unitName} — {formatPkr(unitPriceOf({ variantId: line.variantId, unitId: unit.unitId, quantityMilli: line.quantityMilli, priceOverridePaisa: null }, unit, tier))}</option>)}</SelectInput></Field>
    </div>
    {can("sales.price_override") && <Field label="Price per unit (Rs)"><MoneyInput value={price} onChange={(event) => setPrice(event.target.value)} /></Field>}
    {can("sales.discount") && <Field label="Line discount"><DiscountFields kind={kind} text={discount} onKind={setKind} onText={setDiscount} /></Field>}
    {error && <ErrorMessage>{error}</ErrorMessage>}
    <div className="button-row"><button className="button primary">Save</button><button type="button" className="button secondary" onClick={onRemove}>Remove item</button></div>
  </form></Dialog>;
}

export function HeldSalesDialog({ onClose, onRecalled }: { onClose: () => void; onRecalled: (cart: Cart, name: string) => void }) {
  const queryClient = useQueryClient();
  const list = useQuery({ queryKey: ["held-sales"], queryFn: getAllHeldSales, staleTime: 0 });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function recall(id: string) {
    setBusy(true);
    setError("");
    try {
      const recalled = await recallHeldSale(id);
      const cart = parseStoredCart(recalled.cart);
      if (!cart) throw new Error("This held sale cannot be opened");
      await queryClient.invalidateQueries({ queryKey: ["held-sales"] });
      onRecalled(cart, recalled.name);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not recall the sale");
      setBusy(false);
    }
  }

  async function discard(id: string) {
    setBusy(true);
    setError("");
    try {
      await discardHeldSale(id);
      await queryClient.invalidateQueries({ queryKey: ["held-sales"] });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not discard the sale");
    } finally {
      setBusy(false);
    }
  }

  return <Dialog title="Held sales" onClose={onClose}><div className="stack">
    {list.isPending && <p className="muted">Loading…</p>}
    {list.isError && <ErrorMessage>{list.error.message}</ErrorMessage>}
    {list.data?.length === 0 && <p className="muted">No sales are on hold.</p>}
    {list.data?.map((held) => <div className="held-row" key={held.id}>
      <div><strong>{held.name || "Held sale"}</strong><small>{new Date(held.createdAt).toLocaleTimeString()} · {formatPkr(held.totalPaisa)}</small></div>
      <button className="button primary" disabled={busy} onClick={() => void recall(held.id)}>Recall</button>
      <button className="button secondary" disabled={busy} onClick={() => void discard(held.id)}>Discard</button>
    </div>)}
    {error && <ErrorMessage>{error}</ErrorMessage>}
  </div></Dialog>;
}

const voidReasons = ["Customer changed their mind", "Wrong items were scanned", "Customer could not pay", "Cashier error"] as const;

/** Giving up a sale before payment (FR-SAL-10): a reason is required, and the log keeps what was in the cart. Removing one line needs no reason. */
export function VoidSaleDialog({ itemCount, totalPaisa, lines, onClose, onVoided }: {
  itemCount: number; totalPaisa: number; lines: Array<{ sku: string; quantity: string }>; onClose: () => void; onVoided: (message: string) => void;
}) {
  const [choice, setChoice] = useState<string>(voidReasons[0]);
  const [other, setOther] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const reason = choice === "Other" ? other.trim() : choice;

  async function confirm() {
    setBusy(true);
    setError("");
    try {
      await logVoidedSale({ reason, totalPaisa, lines });
      onVoided("Sale cancelled and logged");
    } catch (caught) {
      // With no connection the log cannot be written; the sale is still given up rather than left on the screen.
      if (caught instanceof NetworkError) onVoided("Sale cancelled. There was no connection, so it was not logged.");
      else {
        setError(caught instanceof Error ? caught.message : "Could not cancel the sale");
        setBusy(false);
      }
    }
  }

  return <Dialog title="Cancel this sale" onClose={() => { if (!busy) onClose(); }}>
    <div className="stack">
      <p>{itemCount} {itemCount === 1 ? "item" : "items"} worth {formatPkr(totalPaisa)} will be removed. Nothing has been paid or posted. The cancellation is logged with your name.</p>
      <Field label="Why?">
        <SelectInput value={choice} onChange={(event) => setChoice(event.target.value)}>
          {voidReasons.map((value) => <option key={value} value={value}>{value}</option>)}<option value="Other">Other</option>
        </SelectInput>
      </Field>
      {choice === "Other" && <Field label="Say why"><TextInput value={other} maxLength={200} onChange={(event) => setOther(event.target.value)} autoFocus /></Field>}
      {error && <ErrorMessage>{error}</ErrorMessage>}
      <div className="button-row">
        <button className="button primary" disabled={busy || reason.length < 3} onClick={() => void confirm()}>Cancel the sale</button>
        <button className="button secondary" disabled={busy} onClick={onClose}>Keep it</button>
      </div>
    </div>
  </Dialog>;
}
