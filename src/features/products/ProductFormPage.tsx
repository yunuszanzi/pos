import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useFieldArray, useForm, useWatch, type Control, type UseFormRegister } from "react-hook-form";
import { Link, useNavigate, useParams } from "react-router-dom";
import { generateInternalEan13 } from "../../../shared/barcode";
import { parseRupees, toPlainRupees } from "../../../shared/money";
import { productSchema, type ProductInput } from "../../../shared/schemas/catalogue";
import { getAllBrands, getAllCategories, getAllTaxCategories, getAllUnits, type Unit } from "../../api/catalogueApi";
import { createProduct, getProductById, updateProduct, type Product } from "../../api/productsApi";
import { ErrorMessage, Field, PageTitle, SelectInput, TextInput } from "../../app/FormElements";
import { useCan } from "../../app/permissions";
import { categoryLabels } from "./categoryLabels";

type OtherUnitForm = { unitId: string; factor: string; barcode: string; price: string; fbrUom: string };
type VariantForm = {
  id: string;
  sku: string;
  variantName: string;
  cost: string;
  reorderLevel: string;
  reorderQuantity: string;
  basePrice: string;
  baseBarcode: string;
  baseFbrUom: string;
  attributes: Record<string, string>;
  otherUnits: OtherUnitForm[];
};
type FormValues = {
  name: string;
  description: string;
  imageUrl: string;
  categoryId: string;
  brandId: string;
  taxCategoryId: string;
  hsCode: string;
  productType: "stocked" | "non_stock" | "service";
  baseUnitId: string;
  active: boolean;
  variants: VariantForm[];
};

const referenceStaleTime = 5 * 60_000;
const blankVariant = (): VariantForm => ({
  id: "", sku: "", variantName: "", cost: "", reorderLevel: "", reorderQuantity: "", basePrice: "", baseBarcode: "", baseFbrUom: "", attributes: {}, otherUnits: [],
});

function toFormValues(product: Product): FormValues {
  return {
    name: product.name,
    description: product.description,
    imageUrl: product.imageUrl ?? "",
    categoryId: product.categoryId ?? "",
    brandId: product.brandId ?? "",
    taxCategoryId: product.taxCategoryId ?? "",
    hsCode: product.hsCode ?? "",
    productType: product.productType,
    baseUnitId: product.baseUnitId,
    active: product.active,
    variants: product.variants.filter((variant) => variant.active).map((variant) => {
      const base = variant.units.find((unit) => unit.isBase);
      return {
        id: variant.id,
        sku: variant.sku,
        variantName: variant.variantName,
        cost: variant.costPaisa === undefined ? "" : toPlainRupees(variant.costPaisa),
        reorderLevel: variant.reorderLevel,
        reorderQuantity: variant.reorderQuantity,
        basePrice: base ? toPlainRupees(base.salePricePaisa) : "",
        baseBarcode: base?.barcode ?? "",
        baseFbrUom: base?.fbrUom ?? "",
        attributes: variant.attributes,
        otherUnits: variant.units.filter((unit) => !unit.isBase).map((unit) => ({
          unitId: unit.unitId, factor: unit.factorToBase, barcode: unit.barcode ?? "", price: toPlainRupees(unit.salePricePaisa), fbrUom: unit.fbrUom ?? "",
        })),
      };
    }),
  };
}

function rupees(text: string, what: string): number {
  try {
    return parseRupees(text.trim() || "0");
  } catch {
    throw new Error(`${what}: "${text}" is not a valid amount. Use rupees with up to two decimals, e.g. 1250.50`);
  }
}

function toProductInput(values: FormValues, withCost: boolean): ProductInput {
  return {
    name: values.name,
    description: values.description,
    imageUrl: values.imageUrl || null,
    categoryId: values.categoryId || null,
    brandId: values.brandId || null,
    taxCategoryId: values.taxCategoryId || null,
    hsCode: values.hsCode || null,
    productType: values.productType,
    baseUnitId: values.baseUnitId,
    active: values.active,
    variants: values.variants.map((variant) => ({
      id: variant.id || undefined,
      sku: variant.sku,
      variantName: variant.variantName,
      attributes: variant.attributes,
      costPaisa: withCost ? rupees(variant.cost, `Cost of ${variant.sku || "a variant"}`) : 0,
      reorderLevel: variant.reorderLevel.trim() || "0",
      reorderQuantity: variant.reorderQuantity.trim() || "0",
      units: [
        { unitId: values.baseUnitId, factorToBase: "1", barcode: variant.baseBarcode.trim() || null, salePricePaisa: rupees(variant.basePrice, `Sale price of ${variant.sku || "a variant"}`), fbrUom: variant.baseFbrUom || null },
        ...variant.otherUnits.map((unit) => ({
          unitId: unit.unitId, factorToBase: unit.factor.trim(), barcode: unit.barcode.trim() || null,
          salePricePaisa: rupees(unit.price, `Price of ${variant.sku || "a variant"} per unit`), fbrUom: unit.fbrUom || null,
        })),
      ],
    })),
  };
}

const randomUnit = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;

export function ProductFormPage() {
  const { id } = useParams();
  const isNew = id === undefined;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canSeeCost = useCan("products.cost.view");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const form = useForm<FormValues>({
    defaultValues: {
      name: "", description: "", imageUrl: "", categoryId: "", brandId: "", taxCategoryId: "", hsCode: "",
      productType: "stocked", baseUnitId: "", active: true, variants: [blankVariant()],
    },
  });
  const { fields, append, remove } = useFieldArray({ control: form.control, name: "variants" });

  const categories = useQuery({ queryKey: ["categories"], queryFn: getAllCategories, staleTime: referenceStaleTime });
  const brands = useQuery({ queryKey: ["brands"], queryFn: getAllBrands, staleTime: referenceStaleTime });
  const taxCategories = useQuery({ queryKey: ["tax-categories"], queryFn: getAllTaxCategories, staleTime: referenceStaleTime });
  const units = useQuery({ queryKey: ["units"], queryFn: getAllUnits, staleTime: referenceStaleTime });
  const product = useQuery({ queryKey: ["product", id], queryFn: () => getProductById(id!), enabled: !isNew });

  useEffect(() => {
    if (product.data) form.reset(toFormValues(product.data));
  }, [product.data, form]);
  useEffect(() => {
    // A new product starts with Piece as its base unit, the common case.
    if (isNew && units.data && !form.getValues("baseUnitId")) {
      const piece = units.data.find((unit) => unit.name === "Piece") ?? units.data[0];
      if (piece) form.setValue("baseUnitId", piece.id);
    }
  }, [isNew, units.data, form]);

  const labels = categoryLabels(categories.data ?? []);
  const activeUnits = (units.data ?? []).filter((unit) => unit.active);
  const baseUnitId = useWatch({ control: form.control, name: "baseUnitId" });

  const submit = form.handleSubmit(async (values) => {
    setError("");
    let input: ProductInput;
    try {
      input = toProductInput(values, canSeeCost);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Check the amounts");
      return;
    }
    const checked = productSchema.safeParse(input);
    if (!checked.success) {
      const [issue] = checked.error.issues;
      setError(`${issue.path.join(" › ")}: ${issue.message}`);
      return;
    }
    setBusy(true);
    try {
      if (isNew) await createProduct(input);
      else await updateProduct(id, input);
      await queryClient.invalidateQueries({ queryKey: ["products"] });
      await queryClient.invalidateQueries({ queryKey: ["product", id] });
      navigate("/products");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the product");
    } finally {
      setBusy(false);
    }
  });

  if (!isNew && product.isPending) return <div className="content"><p className="muted">Loading product…</p></div>;
  if (!isNew && product.isError) return <div className="content"><ErrorMessage>{product.error.message}</ErrorMessage><Link className="text-button" to="/products">Back to products</Link></div>;

  return <div className="content">
    <PageTitle title={isNew ? "New product" : "Edit product"} description="A product has one or more SKUs. Each SKU is sold in its base unit and, optionally, larger units such as packs or cartons." />
    <form className="stack" onSubmit={(event) => void submit(event)}>
      {error && <ErrorMessage>{error}</ErrorMessage>}
      <section className="panel stack">
        <h2>Details</h2>
        <div className="form-grid">
          <Field label="Product name"><TextInput {...form.register("name", { required: true })} required maxLength={200} /></Field>
          <Field label="Category">
            <SelectInput {...form.register("categoryId")}><option value="">None</option>{[...labels].map(([categoryId, label]) => <option key={categoryId} value={categoryId}>{label}</option>)}</SelectInput>
          </Field>
          <Field label="Brand">
            <SelectInput {...form.register("brandId")}><option value="">None</option>{(brands.data ?? []).filter((brand) => brand.active).map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}</SelectInput>
          </Field>
          <Field label="Tax category">
            <SelectInput {...form.register("taxCategoryId")}><option value="">None</option>{(taxCategories.data ?? []).filter((tax) => tax.active).map((tax) => <option key={tax.id} value={tax.id}>{tax.name}</option>)}</SelectInput>
          </Field>
          <Field label="HS code"><TextInput {...form.register("hsCode")} placeholder="9503.0090" maxLength={12} /></Field>
          <Field label="Product type">
            <SelectInput {...form.register("productType")}><option value="stocked">Stocked item</option><option value="non_stock">Non-stock item</option><option value="service">Service</option></SelectInput>
          </Field>
          <Field label="Base unit">
            <SelectInput {...form.register("baseUnitId", { required: true })}>
              {activeUnits.map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}
            </SelectInput>
          </Field>
          <Field label="Description"><TextInput {...form.register("description")} maxLength={2000} /></Field>
        </div>
        {!isNew && <label className="checkbox-row"><input type="checkbox" {...form.register("active")} /><span><strong>Active</strong><small>Archived products cannot be sold or looked up by barcode.</small></span></label>}
      </section>

      {fields.map((field, index) => <section className="panel stack" key={field.id} aria-label={`SKU ${index + 1}`}>
        <div className="button-row">
          <h2>SKU {index + 1}</h2>
          {fields.length > 1 && <button className="text-button" type="button" onClick={() => remove(index)}>{form.getValues(`variants.${index}.id`) ? "Remove (archives this SKU)" : "Remove"}</button>}
        </div>
        <div className="form-grid">
          <Field label="SKU"><TextInput {...form.register(`variants.${index}.sku`, { required: true })} required maxLength={64} /></Field>
          <Field label="Variant name"><TextInput {...form.register(`variants.${index}.variantName`)} placeholder="Red / 12 inch" maxLength={200} /></Field>
          <Field label="Sale price per base unit (PKR)"><TextInput {...form.register(`variants.${index}.basePrice`)} inputMode="decimal" placeholder="0.00" /></Field>
          {canSeeCost && <Field label="Cost per base unit (PKR)"><TextInput {...form.register(`variants.${index}.cost`)} inputMode="decimal" placeholder="0.00" /></Field>}
          <Field label="Barcode (base unit)">
            <div className="button-row">
              <TextInput {...form.register(`variants.${index}.baseBarcode`)} maxLength={64} />
              <button className="button secondary" type="button" onClick={() => form.setValue(`variants.${index}.baseBarcode`, generateInternalEan13(randomUnit), { shouldDirty: true })}>Generate</button>
            </div>
          </Field>
          <Field label="Reorder level"><TextInput {...form.register(`variants.${index}.reorderLevel`)} inputMode="decimal" placeholder="0" /></Field>
          <Field label="Reorder quantity"><TextInput {...form.register(`variants.${index}.reorderQuantity`)} inputMode="decimal" placeholder="0" /></Field>
        </div>
        <OtherUnits index={index} control={form.control} register={form.register} units={activeUnits} baseUnitId={baseUnitId} />
      </section>)}

      <div className="button-row">
        <button className="button secondary" type="button" onClick={() => append(blankVariant())}>Add SKU (variant)</button>
        <button className="button primary" disabled={busy}>{busy ? "Saving…" : "Save product"}</button>
        <Link className="button secondary" to="/products">Cancel</Link>
      </div>
    </form>
  </div>;
}

function OtherUnits({ index, control, register, units, baseUnitId }: {
  index: number;
  control: Control<FormValues>;
  register: UseFormRegister<FormValues>;
  units: Unit[];
  baseUnitId: string;
}) {
  const { fields, append, remove } = useFieldArray({ control, name: `variants.${index}.otherUnits` });
  const rows = useWatch({ control, name: `variants.${index}.otherUnits` });
  const unitName = (unitId: string) => units.find((unit) => unit.id === unitId)?.name ?? "unit";
  const choices = units.filter((unit) => unit.id !== baseUnitId);
  return <fieldset className="permission-list">
    <legend>Other units (pack, carton…)</legend>
    {fields.map((field, unitIndex) => {
      const row = rows?.[unitIndex];
      return <div className="stack" key={field.id}>
        <div className="form-grid">
          <Field label="Unit"><SelectInput {...register(`variants.${index}.otherUnits.${unitIndex}.unitId`)}>{choices.map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}</SelectInput></Field>
          <Field label={`${unitName(baseUnitId)}s in one of this unit`}><TextInput {...register(`variants.${index}.otherUnits.${unitIndex}.factor`)} inputMode="decimal" placeholder="200" /></Field>
          <Field label="Barcode (this unit)"><TextInput {...register(`variants.${index}.otherUnits.${unitIndex}.barcode`)} maxLength={64} /></Field>
          <Field label="Sale price per this unit (PKR)"><TextInput {...register(`variants.${index}.otherUnits.${unitIndex}.price`)} inputMode="decimal" placeholder="0.00" /></Field>
        </div>
        <div className="button-row">
          {row?.factor && <span className="muted">1 {unitName(row.unitId)} = {row.factor} {unitName(baseUnitId)}</span>}
          <button className="text-button" type="button" onClick={() => remove(unitIndex)}>Remove unit</button>
        </div>
      </div>;
    })}
    <button className="button secondary" type="button" disabled={!choices.length} onClick={() => append({ unitId: choices[0]?.id ?? "", factor: "", barcode: "", price: "", fbrUom: "" })}>Add unit</button>
  </fieldset>;
}
