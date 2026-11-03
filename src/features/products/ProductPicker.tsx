import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getAllProducts, type Product, type ProductVariant } from "../../api/productsApi";
import { Field, TextInput } from "../../app/FormElements";

/**
 * Search for a product by name, SKU or barcode and pick one of its SKUs. Searches the server after a 300 ms
 * pause and cancels stale requests; the caller decides what picking does and which SKUs are already taken.
 */
export function ProductPicker({ label = "Find a product to add", stockedOnly = false, isPicked, onPick }: {
  label?: string;
  stockedOnly?: boolean;
  isPicked: (variantId: string) => boolean;
  onPick: (product: Product, variant: ProductVariant) => void;
}) {
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const results = useQuery({
    queryKey: ["products", { picker: debounced }],
    queryFn: ({ signal }) => getAllProducts({ q: debounced, pageSize: 8, active: "true" }, signal),
    enabled: debounced.length > 0,
  });

  const choices = (results.data?.data ?? [])
    .filter((product) => !stockedOnly || product.productType === "stocked")
    .flatMap((product) => product.variants.filter((variant) => variant.active).map((variant) => ({ product, variant })));

  return <>
    <Field label={label}><TextInput type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, SKU or barcode" /></Field>
    {debounced && results.isPending && <p className="muted">Searching…</p>}
    {debounced && results.isError && <p className="muted" role="alert">{results.error.message}</p>}
    {debounced && results.data && !choices.length && <p className="muted">{stockedOnly ? "No stocked product matches." : "No product matches."}</p>}
    {choices.length > 0 && <ul className="role-list" aria-label="Search results">{choices.map(({ product, variant }) => <li key={variant.id}>
      <span><strong>{product.name}</strong><small>{variant.sku}{variant.variantName ? ` · ${variant.variantName}` : ""}</small></span>
      <button className="text-button" type="button" disabled={isPicked(variant.id)} onClick={() => { onPick(product, variant); setSearch(""); }}>Add {variant.sku}</button>
    </li>)}</ul>}
  </>;
}
