import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getAllCustomers } from "../../api/customersApi";
import { Field, TextInput } from "../../app/FormElements";

export type PickedCustomer = { id: string; name: string; phone: string };

/** Finds a customer by name or phone; waits for a pause in typing and drops answers to older searches. */
export function CustomerPicker({ value, onChange, disabled = false }: { value: PickedCustomer | null; onChange: (customer: PickedCustomer | null) => void; disabled?: boolean }) {
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(text.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [text]);
  const found = useQuery({
    queryKey: ["customers", { picker: search }], queryFn: ({ signal }) => getAllCustomers({ q: search, pageSize: 6 }, signal), enabled: !value && search.length > 0,
  });

  if (value) {
    return <div className="field"><span>Customer</span><p><strong>{value.name}</strong>{!disabled && <> <button type="button" className="text-button" onClick={() => onChange(null)}>change</button></>}</p></div>;
  }
  return <div className="stack">
    <Field label="Customer"><TextInput aria-label="Find a customer" placeholder="Name or phone" value={text} onChange={(event) => setText(event.target.value)} /></Field>
    {found.data?.data.map((customer) => <button type="button" key={customer.id} className="button secondary" onClick={() => { onChange({ id: customer.id, name: customer.name, phone: customer.phone }); setText(""); }}>
      {customer.name}{customer.phone ? ` · ${customer.phone}` : ""}
    </button>)}
    {found.isSuccess && found.data.data.length === 0 && <p className="muted">No customer found.</p>}
  </div>;
}
