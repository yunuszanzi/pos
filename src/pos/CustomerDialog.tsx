import { useMemo, useState, type FormEvent } from "react";
import { quickAddCustomer, type Customer, type TillCustomer } from "../api/customersApi";
import { ErrorMessage, Field, TextInput } from "../app/FormElements";
import { Dialog } from "./Dialog";
import { usePos } from "./pos-context";

/** What the till keeps of a customer it has just added. */
const toTillCustomer = (customer: Customer): TillCustomer => ({
  id: customer.id, name: customer.name, businessName: customer.businessName, phone: customer.phone, phone2: customer.phone2, whatsapp: customer.whatsapp,
  address: customer.address, areaId: customer.areaId, groupId: customer.groupId, registered: customer.registered, ntn: customer.ntn, strn: customer.strn,
  priceListId: customer.priceListId, creditLimitPaisa: customer.creditLimitPaisa, termsDays: customer.termsDays, active: customer.active,
});

/** Pick who the sale is for: search the local list by name or phone, add a new customer with just a name and phone, or go back to walk-in. */
export function CustomerDialog({ onClose, onPick }: { onClose: () => void; onPick: (customerId: string | null) => void }) {
  const { customers, can, rememberCustomer, data } = usePos();
  const [text, setText] = useState("");
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const results = useMemo(() => customers.search(text), [customers, text]);
  const listName = (id: string | null) => data.priceLists.find((list) => list.id === id)?.name;

  async function add(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const created = await quickAddCustomer({ name, phone });
      rememberCustomer(toTillCustomer(created));
      onPick(created.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not add the customer");
      setBusy(false);
    }
  }

  return <Dialog title="Customer" onClose={onClose}><div className="stack">
    {!adding && <>
      <TextInput aria-label="Find a customer" placeholder="Name or phone number" value={text} autoFocus autoComplete="off" onChange={(event) => setText(event.target.value)} />
      <div className="customer-results" aria-label="Customers found">
        {results.map((customer) => <button key={customer.id} className="customer-row" onClick={() => onPick(customer.id)}>
          <strong>{customer.name}</strong>
          <small>{[customer.businessName, customer.phone, listName(customer.priceListId) && `Tier: ${listName(customer.priceListId)}`].filter(Boolean).join(" · ")}</small>
        </button>)}
        {text.trim() && results.length === 0 && <p className="muted">No customer matches "{text.trim()}".</p>}
      </div>
      <div className="button-row">
        <button className="button secondary" onClick={() => onPick(null)}>Walk-in (no customer)</button>
        {can("customers.create") && <button className="button secondary" onClick={() => { setAdding(true); setName(text.trim() && !/\d{3}/.test(text) ? text.trim() : ""); }}>Add new customer</button>}
      </div>
    </>}
    {adding && <form className="stack" onSubmit={add}>
      <Field label="Name"><TextInput value={name} onChange={(event) => setName(event.target.value)} autoFocus required maxLength={200} /></Field>
      <Field label="Phone"><TextInput value={phone} inputMode="tel" onChange={(event) => setPhone(event.target.value)} required maxLength={20} /></Field>
      {error && <ErrorMessage>{error}</ErrorMessage>}
      <div className="button-row">
        <button className="button primary" disabled={busy}>{busy ? "Adding…" : "Add and select"}</button>
        <button type="button" className="button secondary" onClick={() => setAdding(false)}>Back</button>
      </div>
    </form>}
  </div></Dialog>;
}
