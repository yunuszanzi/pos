import { useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { toCsv } from "../../../shared/csv";
import { formatPkr } from "../../../shared/money";
import { supplierOpeningBalanceColumns, supplierOpeningBalanceTemplateRows } from "../../../shared/openingBalanceImport";
import { saveTextFile } from "../../api/client";
import { importOpeningPayables, previewOpeningPayables } from "../../api/suppliersApi";
import { ErrorMessage, PageTitle, SuccessMessage } from "../../app/FormElements";
import { IssuesTable } from "../products/IssuesTable";
import { useCsvImport } from "../products/useCsvImport";

/** Go-live: what the shop owed each supplier on the day it moved to this system, loaded from a CSV file. */
export function OpeningPayablesPage() {
  const queryClient = useQueryClient();
  const { fileName, preview, issues, result, error, busy, chooseFile, runImport } = useCsvImport({
    preview: previewOpeningPayables,
    run: importOpeningPayables,
    onImported: () => Promise.all(["suppliers", "supplier-ledger", "supplier-ageing"].map((key) => queryClient.invalidateQueries({ queryKey: [key] }))),
  });

  return <div className="content">
    <PageTitle title="Opening payables" description="Load what you owed each supplier when you started using this system. It is done once per supplier, before their first bill." />
    <p><Link className="text-button" to="/suppliers">← Back to suppliers</Link></p>
    <div className="two-column">
      <section className="panel stack">
        <h2>1. Choose a file</h2>
        <p className="muted">One row per supplier. The supplier must already exist. A positive balance is money you owe them; a negative one is credit you hold with them. The date sets how old the debt is in the ageing report.</p>
        <div className="button-row">
          <button className="button secondary" type="button" onClick={() => saveTextFile(toCsv(supplierOpeningBalanceTemplateRows), "opening-payables-template.csv")}>Download template</button>
        </div>
        <label className="field"><span>CSV file</span><input className="input" type="file" accept=".csv,text/csv" onChange={(event) => void chooseFile(event)} disabled={busy} /></label>
        {fileName && <p className="muted">File: <strong>{fileName}</strong></p>}
        <details><summary>Columns</summary>
          <p className="mono">{supplierOpeningBalanceColumns.join(", ")}</p>
          <p className="muted">Required: balance, and a supplier (by name) or a phone. Use the phone when two suppliers share a name. date is yyyy-mm-dd and defaults to today. note is shown in the ledger.</p>
        </details>
      </section>
      <section className="panel stack">
        <h2>2. Check and import</h2>
        {busy && <p className="muted" role="status">Working…</p>}
        {error && <ErrorMessage>{error}</ErrorMessage>}
        {result && <SuccessMessage>
          Opening payables loaded for {result.suppliers} supplier{result.suppliers === 1 ? "" : "s"}: {formatPkr(result.owedPaisa)} owed
          {result.creditPaisa > 0 && `, ${formatPkr(result.creditPaisa)} credit held with suppliers`}.
        </SuccessMessage>}
        {preview && <>
          <p><strong>{preview.summary.suppliers}</strong> supplier{preview.summary.suppliers === 1 ? "" : "s"} · {formatPkr(preview.summary.owedPaisa)} owed
            {preview.summary.creditPaisa > 0 && ` · ${formatPkr(preview.summary.creditPaisa)} credit`}</p>
          {preview.canImport
            ? <SuccessMessage>The file is valid.</SuccessMessage>
            : <ErrorMessage>{issues.length} problem{issues.length === 1 ? "" : "s"} found. Fix the file and choose it again.</ErrorMessage>}
          <button className="button primary" type="button" disabled={busy || !preview.canImport} onClick={() => void runImport()}>Load opening payables</button>
        </>}
        {!preview && !result && !busy && <p className="muted">Choose a file to see what would change.</p>}
      </section>
    </div>
    <IssuesTable issues={issues} />
  </div>;
}
