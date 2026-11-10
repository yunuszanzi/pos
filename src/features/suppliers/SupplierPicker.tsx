import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getAllSuppliers } from "../../api/suppliersApi";
import { Field, TextInput } from "../../app/FormElements";

export type PickedSupplier = { id: string; name: string };

/** Finds a supplier by name or phone; waits for a pause in typing and drops answers to older searches. */
export function SupplierPicker({ value, onChange, disabled = false }: { value: PickedSupplier | null; onChange: (supplier: PickedSupplier | null) => void; disabled?: boolean }) {
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(text.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [text]);
  const found = useQuery({
    queryKey: ["suppliers", { picker: search }], queryFn: ({ signal }) => getAllSuppliers({ q: search, pageSize: 6 }, signal), enabled: !value && search.length > 0,
  });

  if (value) {
    return <div className="field"><span>Supplier</span><p><strong>{value.name}</strong>{!disabled && <> <button type="button" className="text-button" onClick={() => onChange(null)}>change</button></>}</p></div>;
  }
  return <div className="stack">
    <Field label="Supplier"><TextInput aria-label="Find a supplier" placeholder="Name or phone" value={text} onChange={(event) => setText(event.target.value)} /></Field>
    {found.data?.data.map((supplier) => <button type="button" key={supplier.id} className="button secondary" onClick={() => { onChange({ id: supplier.id, name: supplier.name }); setText(""); }}>
      {supplier.name}{supplier.phone ? ` · ${supplier.phone}` : ""}
    </button>)}
    {found.isSuccess && found.data.data.length === 0 && <p className="muted">No supplier found.</p>}
  </div>;
}
