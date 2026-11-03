import { useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { toCsv } from "../../../shared/csv";
import { importColumns, importTemplateCsvRows } from "../../../shared/productImport";
import { saveTextFile } from "../../api/client";
import { importProducts, previewProductImport } from "../../api/productsApi";
import { ErrorMessage, PageTitle, SuccessMessage } from "../../app/FormElements";
import { IssuesTable } from "./IssuesTable";
import { useCsvImport } from "./useCsvImport";

export function ImportPage() {
  const queryClient = useQueryClient();
  const { fileName, preview, issues, result, error, busy, chooseFile, runImport } = useCsvImport({
    preview: previewProductImport,
    run: importProducts,
    onImported: () => Promise.all(["products", "categories", "brands"].map((key) => queryClient.invalidateQueries({ queryKey: [key] }))),
  });

  return <div className="content">
    <PageTitle title="Import products" description="Add or update many products from a CSV file. The file is checked first; nothing is saved until every row is valid." />
    <div className="two-column">
      <section className="panel stack">
        <h2>1. Choose a file</h2>
        <p className="muted">One row per SKU. Rows with the same product name become variants of one product. For an existing SKU, empty cells keep the current value.</p>
        <div className="button-row">
          <button className="button secondary" type="button" onClick={() => saveTextFile(toCsv(importTemplateCsvRows), "product-import-template.csv")}>Download template</button>
          <Link className="button secondary" to="/products">Back to products</Link>
        </div>
        <label className="field"><span>CSV file</span><input className="input" type="file" accept=".csv,text/csv" onChange={(event) => void chooseFile(event)} disabled={busy} /></label>
        {fileName && <p className="muted">File: <strong>{fileName}</strong></p>}
        <details><summary>Columns</summary><p className="mono">{importColumns.join(", ")}</p><p className="muted">Required: sku, name. Prices are in rupees, e.g. 1250.50. Categories can be nested with &gt; (Balloons &gt; Latex).</p></details>
      </section>
      <section className="panel stack">
        <h2>2. Check and import</h2>
        {busy && <p className="muted" role="status">Working…</p>}
        {error && <ErrorMessage>{error}</ErrorMessage>}
        {result && <SuccessMessage>
          Imported {result.products} product{result.products === 1 ? "" : "s"}: {result.variantsCreated} new SKU{result.variantsCreated === 1 ? "" : "s"}, {result.variantsUpdated} updated.
        </SuccessMessage>}
        {preview && <>
          <p><strong>{preview.summary.products}</strong> products · <strong>{preview.summary.variantsToCreate}</strong> new SKUs · <strong>{preview.summary.variantsToUpdate}</strong> updated SKUs</p>
          {preview.summary.newCategories.length > 0 && <p className="muted">New categories: {preview.summary.newCategories.join(", ")}</p>}
          {preview.summary.newBrands.length > 0 && <p className="muted">New brands: {preview.summary.newBrands.join(", ")}</p>}
          {preview.canImport
            ? <SuccessMessage>The file is valid.</SuccessMessage>
            : <ErrorMessage>{issues.length} problem{issues.length === 1 ? "" : "s"} found. Fix the file and choose it again.</ErrorMessage>}
          <button className="button primary" type="button" disabled={busy || !preview.canImport} onClick={() => void runImport()}>
            Import {preview.summary.products} product{preview.summary.products === 1 ? "" : "s"}
          </button>
        </>}
        {!preview && !result && !busy && <p className="muted">Choose a file to see what would change.</p>}
      </section>
    </div>
    <IssuesTable issues={issues} />
  </div>;
}
