import { useRef, useState, type ChangeEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { toCsv } from "../../../shared/csv";
import { importColumns, importTemplateCsvRows } from "../../../shared/productImport";
import { ApiRequestError, saveTextFile } from "../../api/client";
import { importProducts, previewProductImport, type ImportIssue, type ImportPreview, type ImportResult } from "../../api/productsApi";
import { ErrorMessage, PageTitle, SuccessMessage } from "../../app/FormElements";

const visibleIssueLimit = 200;

export function ImportPage() {
  const queryClient = useQueryClient();
  const [fileName, setFileName] = useState("");
  const [csv, setCsv] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [issues, setIssues] = useState<ImportIssue[]>([]);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // One key per chosen file: clicking Import twice, or retrying after a dropped connection, cannot import twice.
  const idempotencyKey = useRef(crypto.randomUUID());

  async function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = ""; // lets the same file name be chosen again after fixing it
    if (!file) return;
    setError("");
    setResult(null);
    setPreview(null);
    setIssues([]);
    setFileName(file.name);
    idempotencyKey.current = crypto.randomUUID();
    setBusy(true);
    try {
      const text = await file.text();
      setCsv(text);
      const checked = await previewProductImport(text);
      setPreview(checked);
      setIssues(checked.issues);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The file could not be checked");
    } finally {
      setBusy(false);
    }
  }

  async function runImport() {
    setError("");
    setBusy(true);
    try {
      const done = await importProducts(csv, idempotencyKey.current);
      setResult(done);
      setPreview(null);
      await Promise.all(["products", "categories", "brands"].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
    } catch (caught) {
      if (caught instanceof ApiRequestError && caught.code === "IMPORT_HAS_ERRORS") {
        setIssues(caught.details as ImportIssue[]);
        setPreview((current) => current && { ...current, canImport: false, issues: caught.details as ImportIssue[] });
      }
      setError(caught instanceof Error ? caught.message : "The import failed");
    } finally {
      setBusy(false);
    }
  }

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
    {issues.length > 0 && <section className="panel">
      <h2>Problems</h2>
      <div className="table-scroll"><table>
        <thead><tr><th>Row</th><th>Column</th><th>Problem</th></tr></thead>
        <tbody>{issues.slice(0, visibleIssueLimit).map((issue, index) => <tr key={`${issue.row}-${issue.field}-${index}`}>
          <td>{issue.row}</td><td className="mono">{issue.field}</td><td>{issue.message}</td>
        </tr>)}</tbody>
      </table></div>
      {issues.length > visibleIssueLimit && <p className="muted">Showing the first {visibleIssueLimit} of {issues.length} problems.</p>}
    </section>}
  </div>;
}
