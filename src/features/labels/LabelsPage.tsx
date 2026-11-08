import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { expandLabels, labelFormats, labelPageCss, labelsPerPage, layoutLabels, maxLabelsPerPrint } from "../../../shared/labels";
import { formatPkr } from "../../../shared/money";
import { getAllUnits } from "../../api/catalogueApi";
import type { Product, ProductVariant } from "../../api/productsApi";
import { ErrorMessage, Field, PageTitle, SelectInput } from "../../app/FormElements";
import { QuantityInput } from "../../app/QuantityInput";
import { ProductPicker } from "../products/ProductPicker";
import { barcodeImageUrl } from "./barcodeImage";

type Item = { variant: ProductVariant; productName: string; unitId: string; copies: string };
type Label = { name: string; variantName: string; sku: string; priceText: string; barcode: string };

function LabelSheet({ pages, showPrice, showSku }: { pages: Array<Array<Label | null>>; showPrice: boolean; showSku: boolean }) {
  return <>{pages.map((page, pageIndex) => <div className="label-page" key={pageIndex} data-testid="label-page">
    {page.map((label, cellIndex) => <div className="label-cell" key={cellIndex} data-testid={label ? "label" : undefined}>
      {label && <>
        <div><div className="label-name">{label.name}</div>{label.variantName && <div className="label-variant">{label.variantName}</div>}</div>
        {showPrice && <div className="label-price">{label.priceText}</div>}
        <img className="label-barcode" src={barcodeImageUrl(label.barcode)} alt={`Barcode ${label.barcode}`} />
        {showSku && <div className="label-sku">{label.sku}</div>}
      </>}
    </div>)}
  </div>)}</>;
}

export function LabelsPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [formatId, setFormatId] = useState(labelFormats[0].id);
  const [startPosition, setStartPosition] = useState("1");
  const [showPrice, setShowPrice] = useState(true);
  const [showSku, setShowSku] = useState(true);
  const units = useQuery({ queryKey: ["units"], queryFn: getAllUnits, staleTime: 5 * 60_000 });

  const format = labelFormats.find((candidate) => candidate.id === formatId) ?? labelFormats[0];
  const unitName = (unitId: string) => units.data?.find((unit) => unit.id === unitId)?.name ?? "";
  const unitOf = (item: Item) => item.variant.units.find((unit) => unit.unitId === item.unitId);

  function addItem(product: Product, variant: ProductVariant) {
    if (items.some((item) => item.variant.id === variant.id)) return;
    // Start on the first unit that has a barcode, since a label without one cannot be scanned.
    const unit = variant.units.find((candidate) => candidate.barcode) ?? variant.units.find((candidate) => candidate.isBase) ?? variant.units[0];
    setItems([...items, { variant, productName: product.name, unitId: unit.unitId, copies: "1" }]);
  }
  const change = (index: number, patch: Partial<Item>) => setItems(items.map((item, position) => (position === index ? { ...item, ...patch } : item)));

  const layout = useMemo(() => {
    const printable = items.flatMap((item) => {
      const unit = item.variant.units.find((candidate) => candidate.unitId === item.unitId);
      const copies = Number(item.copies);
      if (!unit?.barcode || !Number.isInteger(copies) || copies < 1) return [];
      return [{ key: `${item.variant.id}|${item.unitId}`, copies, label: {
        name: item.productName, variantName: item.variant.variantName, sku: item.variant.sku, priceText: formatPkr(unit.salePricePaisa), barcode: unit.barcode,
      } satisfies Label }];
    });
    try {
      const labels = expandLabels(printable).map((entry) => entry.label);
      const start = Number(startPosition);
      return { labels, pages: layoutLabels(labels, format, format.kind === "sheet" ? start : 1), error: "" };
    } catch (caught) {
      return { labels: [] as Label[], pages: [] as Array<Array<Label | null>>, error: caught instanceof Error ? caught.message : "Check the label settings" };
    }
  }, [items, format, startPosition]);

  const withoutBarcode = items.filter((item) => !unitOf(item)?.barcode);
  const css = labelPageCss(format);

  return <div className="content">
    <PageTitle title="Print barcode labels" description="Choose the products, how many labels of each, and the label stock. Labels print from the browser's print dialog." />
    <style>{css}</style>
    {layout.error && <ErrorMessage>{layout.error}</ErrorMessage>}
    <div className="two-column">
      <section className="panel stack" aria-label="Labels to print">
        <h2>1. Products</h2>
        <ProductPicker isPicked={(variantId) => items.some((item) => item.variant.id === variantId)} onPick={addItem} />
        {items.map((item, index) => <div className="form-grid" key={item.variant.id} role="group" aria-label={`Label ${item.variant.sku}`}>
          <div><strong>{item.productName}</strong><br /><span className="mono">{item.variant.sku}</span></div>
          <Field label="Unit (its barcode is printed)">
            <SelectInput value={item.unitId} onChange={(event) => change(index, { unitId: event.target.value })}>
              {item.variant.units.map((unit) => <option key={unit.unitId} value={unit.unitId}>{unitName(unit.unitId)}{unit.barcode ? "" : " (no barcode)"}</option>)}
            </SelectInput>
          </Field>
          <Field label="Copies"><QuantityInput decimals={0} value={item.copies} onChange={(event) => change(index, { copies: event.target.value })} /></Field>
          <button className="text-button" type="button" onClick={() => setItems(items.filter((_, position) => position !== index))}>Remove</button>
        </div>)}
        {!items.length && <p className="muted">No products added yet.</p>}
        {withoutBarcode.length > 0 && <ErrorMessage>
          {withoutBarcode.map((item) => item.variant.sku).join(", ")} {withoutBarcode.length === 1 ? "has" : "have"} no barcode on the chosen unit and will not be printed. Edit the product and press Generate to give it one.
        </ErrorMessage>}
      </section>

      <section className="panel stack" aria-label="Label layout">
        <h2>2. Label stock</h2>
        <Field label="Label format"><SelectInput value={formatId} onChange={(event) => setFormatId(event.target.value)}>{labelFormats.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</SelectInput></Field>
        {format.kind === "sheet" && <Field label={`Start at position (1 to ${labelsPerPage(format)})`}>
          <QuantityInput decimals={0} value={startPosition} onChange={(event) => setStartPosition(event.target.value)} />
        </Field>}
        <label className="checkbox-row"><input type="checkbox" checked={showPrice} onChange={(event) => setShowPrice(event.target.checked)} /><span><strong>Show price</strong></span></label>
        <label className="checkbox-row"><input type="checkbox" checked={showSku} onChange={(event) => setShowSku(event.target.checked)} /><span><strong>Show SKU</strong></span></label>
        <p className="muted">Sizes follow the common layouts for this stock. Print one sheet on plain paper and hold it against a label sheet to check it before printing a full run (up to {maxLabelsPerPrint} labels at a time).</p>
        <div className="button-row">
          <button className="button primary" type="button" disabled={!layout.labels.length} onClick={() => window.print()}>
            Print {layout.labels.length} label{layout.labels.length === 1 ? "" : "s"}
          </button>
          <Link className="button secondary" to="/products">Back to products</Link>
        </div>
      </section>
    </div>

    <section className="panel stack" aria-label="Preview">
      <h2>Preview {layout.pages.length > 0 && <small className="muted">· {layout.pages.length} page{layout.pages.length === 1 ? "" : "s"}</small>}</h2>
      {layout.pages.length === 0 && <p className="muted">Add a product with a barcode to see the labels.</p>}
      <div className="label-preview"><LabelSheet pages={layout.pages} showPrice={showPrice} showSku={showSku} /></div>
    </section>
    {createPortal(<div className="label-print-root"><LabelSheet pages={layout.pages} showPrice={showPrice} showSku={showSku} /></div>, document.body)}
  </div>;
}
