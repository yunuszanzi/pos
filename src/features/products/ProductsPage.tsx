import { useEffect, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { formatPkr } from "../../../shared/money";
import { getAllBrands, getAllCategories, getAllUnits } from "../../api/catalogueApi";
import { archiveProduct, downloadProductsCsv, getAllProducts, type Product } from "../../api/productsApi";
import { ErrorMessage, PageTitle, SelectInput, SuccessMessage, TextInput } from "../../app/FormElements";
import { useCan } from "../../app/permissions";
import { categoryLabels } from "./categoryLabels";

const pageSize = 25;
const referenceStaleTime = 5 * 60_000;

export function ProductsPage() {
  const queryClient = useQueryClient();
  const canManage = useCan("catalog.manage");
  const canImport = useCan("products.import");
  const canExport = useCan("products.export");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [status, setStatus] = useState<"true" | "false" | "all">("true");
  const [categoryId, setCategoryId] = useState("");
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // Wait for a pause in typing before asking the server (300 ms, technical-plan 5.7).
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const categories = useQuery({ queryKey: ["categories"], queryFn: getAllCategories, staleTime: referenceStaleTime });
  const brands = useQuery({ queryKey: ["brands"], queryFn: getAllBrands, staleTime: referenceStaleTime });
  const units = useQuery({ queryKey: ["units"], queryFn: getAllUnits, staleTime: referenceStaleTime });
  const products = useQuery({
    queryKey: ["products", { q: debouncedSearch, status, categoryId, page }],
    queryFn: ({ signal }) => getAllProducts({ q: debouncedSearch, active: status, categoryId, page, pageSize }, signal),
    placeholderData: keepPreviousData,
  });

  const labels = categoryLabels(categories.data ?? []);
  const unitName = new Map((units.data ?? []).map((unit) => [unit.id, unit.shortName]));
  const brandName = new Map((brands.data ?? []).map((brand) => [brand.id, brand.name]));
  const rows = products.data?.data ?? [];
  const total = products.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  async function archive(product: Product) {
    setError("");
    setNotice("");
    try {
      await archiveProduct(product.id);
      setNotice(`${product.name} was archived. Its history is kept.`);
      await queryClient.invalidateQueries({ queryKey: ["products"] });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not archive the product");
    }
  }

  async function exportCsv() {
    setError("");
    try {
      await downloadProductsCsv();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not export products");
    }
  }

  return <div className="content">
    <PageTitle title="Products" description="Search by name, SKU or barcode. Each product has one or more SKUs, sold in one or more units." />
    {error && <ErrorMessage>{error}</ErrorMessage>}
    {notice && <SuccessMessage>{notice}</SuccessMessage>}
    {products.isError && <ErrorMessage>{products.error.message}</ErrorMessage>}
    <section className="panel stack">
      <div className="form-actions">
        <label className="field"><span>Search</span><TextInput type="search" placeholder="Name, SKU or barcode" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
        <label className="field"><span>Category</span>
          <SelectInput value={categoryId} onChange={(event) => { setCategoryId(event.target.value); setPage(1); }}>
            <option value="">All categories</option>
            {[...labels].map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </SelectInput>
        </label>
        <label className="field"><span>Status</span>
          <SelectInput value={status} onChange={(event) => { setStatus(event.target.value as typeof status); setPage(1); }}>
            <option value="true">Active</option><option value="false">Archived</option><option value="all">All</option>
          </SelectInput>
        </label>
      </div>
      <div className="button-row">
        {canManage && <Link className="button primary" to="/products/new">New product</Link>}
        {canImport && <Link className="button secondary" to="/products/import">Import CSV</Link>}
        {canExport && <button className="button secondary" type="button" onClick={() => void exportCsv()}>Export CSV</button>}
      </div>
      <div className="table-scroll"><table>
        <thead><tr><th>Product</th><th>SKUs</th><th>Category</th><th>Brand</th><th>Units</th><th>Price</th><th>Status</th><th /></tr></thead>
        <tbody>{rows.map((product) => {
          const variants = product.variants.filter((variant) => variant.active);
          const shown = variants.length ? variants : product.variants;
          const baseUnit = shown[0]?.units.find((unit) => unit.isBase);
          const prices = shown.flatMap((variant) => variant.units.filter((unit) => unit.isBase).map((unit) => unit.salePricePaisa));
          const low = Math.min(...prices);
          const high = Math.max(...prices);
          return <tr key={product.id}>
            <td><strong>{product.name}</strong></td>
            <td className="mono">{shown.slice(0, 3).map((variant) => variant.sku).join(", ")}{shown.length > 3 ? ` +${shown.length - 3}` : ""}</td>
            <td>{product.categoryId ? labels.get(product.categoryId) ?? "—" : "—"}</td>
            <td>{product.brandId ? brandName.get(product.brandId) ?? "—" : "—"}</td>
            <td>{[...new Set(shown.flatMap((variant) => variant.units.map((unit) => unitName.get(unit.unitId) ?? "?")))].join(", ")}</td>
            <td>{prices.length ? `${formatPkr(low)}${high !== low ? ` – ${formatPkr(high)}` : ""}` : "—"}{baseUnit ? ` / ${unitName.get(baseUnit.unitId) ?? ""}` : ""}</td>
            <td><span className={product.active ? "status active" : "status"}>{product.active ? "Active" : "Archived"}</span></td>
            <td className="action-cell">
              {canManage && <Link className="text-button" to={`/products/${product.id}`}>Edit</Link>}
              {canManage && product.active && <button className="text-button" type="button" onClick={() => void archive(product)}>Archive</button>}
            </td>
          </tr>;
        })}</tbody>
      </table></div>
      {products.isPending && <p className="muted">Loading products…</p>}
      {!products.isPending && !rows.length && <p className="muted">{debouncedSearch ? "No products match your search." : "No products yet."}</p>}
      <div className="button-row">
        <button className="button secondary" type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
        <span className="muted" role="status">Page {page} of {pageCount} · {total} product{total === 1 ? "" : "s"}</span>
        <button className="button secondary" type="button" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>Next</button>
      </div>
    </section>
  </div>;
}
