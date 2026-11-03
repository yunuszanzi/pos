import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatBps, parsePercentToBps } from "../../../shared/money";
import {
  createBrand, createCategory, createUnit, getAllBrands, getAllCategories, getAllTaxCategories, getAllUnits,
  updateBrand, updateCategory, updateTaxCategory, updateUnit, type TaxCategory,
} from "../../api/catalogueApi";
import { ErrorMessage, Field, PageTitle, SelectInput, SuccessMessage, TextInput } from "../../app/FormElements";
import { useCan } from "../../app/permissions";
import { categoryLabels } from "./categoryLabels";

const staleTime = 5 * 60_000;

export function CatalogueSetupPage() {
  const queryClient = useQueryClient();
  const canManage = useCan("catalog.manage");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const categories = useQuery({ queryKey: ["categories"], queryFn: getAllCategories, staleTime });
  const brands = useQuery({ queryKey: ["brands"], queryFn: getAllBrands, staleTime });
  const taxCategories = useQuery({ queryKey: ["tax-categories"], queryFn: getAllTaxCategories, staleTime });
  const units = useQuery({ queryKey: ["units"], queryFn: getAllUnits, staleTime });
  const labels = categoryLabels(categories.data ?? []);
  const categoryRows = (categories.data ?? []).filter((category) => labels.has(category.id))
    .sort((a, b) => (labels.get(a.id) ?? "").localeCompare(labels.get(b.id) ?? ""));

  /** Runs a save, then refreshes the list it changed. */
  async function run(key: string, work: () => Promise<unknown>, done: string) {
    setError("");
    setNotice("");
    try {
      await work();
      await queryClient.invalidateQueries({ queryKey: [key] });
      setNotice(done);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save");
    }
  }

  const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
  const submit = (handler: (form: FormData) => void) => (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const element = event.currentTarget;
    handler(new FormData(element));
    element.reset();
  };

  return <div className="content">
    <PageTitle title="Categories, brands, tax and units" description="Reference data used by products. Tax rates are settings, so a rate change needs no software update." />
    {error && <ErrorMessage>{error}</ErrorMessage>}
    {notice && <SuccessMessage>{notice}</SuccessMessage>}
    <div className="two-column">
      <section className="panel stack" aria-label="Categories">
        <h2>Categories</h2>
        <ul className="role-list">{categoryRows.map((category) => <li key={category.id}>
          <span><strong>{labels.get(category.id)}</strong></span>
          {canManage && <button className="text-button" type="button" onClick={() => void run("categories", () => updateCategory(category.id, { active: !category.active }), category.active ? "Category archived." : "Category restored.")}>{category.active ? "Archive" : "Restore"}</button>}
        </li>)}</ul>
        {categories.data && !categories.data.length && <p className="muted">No categories yet.</p>}
        {canManage && <form className="stack" onSubmit={submit((form) => void run("categories", () => createCategory({ name: text(form, "name"), parentId: text(form, "parentId") || null }), "Category added."))}>
          <Field label="New category name"><TextInput name="name" required maxLength={200} /></Field>
          <Field label="Inside"><SelectInput name="parentId" defaultValue=""><option value="">Top level</option>{[...labels].map(([id, label]) => <option key={id} value={id}>{label}</option>)}</SelectInput></Field>
          <button className="button primary">Add category</button>
        </form>}
      </section>

      <section className="panel stack" aria-label="Brands">
        <h2>Brands</h2>
        <ul className="role-list">{(brands.data ?? []).map((brand) => <li key={brand.id}>
          <span><strong>{brand.name}</strong></span>
          {canManage && <button className="text-button" type="button" onClick={() => void run("brands", () => updateBrand(brand.id, { active: !brand.active }), brand.active ? "Brand archived." : "Brand restored.")}>{brand.active ? "Archive" : "Restore"}</button>}
        </li>)}</ul>
        {brands.data && !brands.data.length && <p className="muted">No brands yet.</p>}
        {canManage && <form className="stack" onSubmit={submit((form) => void run("brands", () => createBrand({ name: text(form, "name") }), "Brand added."))}>
          <Field label="New brand name"><TextInput name="name" required maxLength={200} /></Field>
          <button className="button primary">Add brand</button>
        </form>}
      </section>
    </div>

    <section className="panel stack" aria-label="Tax categories">
      <h2>Tax categories</h2>
      <p className="muted">Check these rates and FBR sale types against your tax advisor. Changing a rate affects new sales only; posted invoices keep the rate they were issued with.</p>
      <div className="table-scroll"><table>
        <thead><tr><th>Name</th><th>Rate (%)</th><th>FBR sale type</th><th /></tr></thead>
        <tbody>{(taxCategories.data ?? []).map((tax) => <TaxRow key={`${tax.id}-${tax.rateBps}-${tax.fbrSaleType}`} tax={tax} editable={canManage}
          onSave={(rateBps, fbrSaleType) => void run("tax-categories", () => updateTaxCategory(tax.id, { rateBps, fbrSaleType }), `${tax.name} saved.`)}
          onError={setError} />)}</tbody>
      </table></div>
    </section>

    <section className="panel stack" aria-label="Units">
      <h2>Units of measure</h2>
      <ul className="role-list">{(units.data ?? []).map((unit) => <li key={unit.id}>
        <span><strong>{unit.name}</strong><small>{unit.shortName}</small></span>
        {canManage && <button className="text-button" type="button" onClick={() => void run("units", () => updateUnit(unit.id, { active: !unit.active }), unit.active ? "Unit archived." : "Unit restored.")}>{unit.active ? "Archive" : "Restore"}</button>}
      </li>)}</ul>
      {canManage && <form className="form-grid" onSubmit={submit((form) => void run("units", () => createUnit({ name: text(form, "name"), shortName: text(form, "shortName") }), "Unit added."))}>
        <Field label="New unit name"><TextInput name="name" required maxLength={60} /></Field>
        <Field label="Short name"><TextInput name="shortName" required maxLength={12} /></Field>
        <button className="button primary">Add unit</button>
      </form>}
    </section>
  </div>;
}

function TaxRow({ tax, editable, onSave, onError }: {
  tax: TaxCategory;
  editable: boolean;
  onSave: (rateBps: number, fbrSaleType: string | null) => void;
  onError: (message: string) => void;
}) {
  const [rate, setRate] = useState(formatBps(tax.rateBps));
  const [saleType, setSaleType] = useState(tax.fbrSaleType ?? "");
  const changed = rate !== formatBps(tax.rateBps) || saleType !== (tax.fbrSaleType ?? "");
  function save() {
    try {
      onSave(parsePercentToBps(rate), saleType.trim() || null);
    } catch {
      onError(`${tax.name}: enter a rate between 0 and 100 with up to two decimals`);
    }
  }
  return <tr>
    <td><strong>{tax.name}</strong></td>
    <td><TextInput aria-label={`${tax.name} rate`} inputMode="decimal" value={rate} onChange={(event) => setRate(event.target.value)} readOnly={!editable} /></td>
    <td><TextInput aria-label={`${tax.name} FBR sale type`} value={saleType} onChange={(event) => setSaleType(event.target.value)} readOnly={!editable} maxLength={120} /></td>
    <td className="action-cell">{editable && <button className="text-button" type="button" disabled={!changed} onClick={save}>Save</button>}</td>
  </tr>;
}
