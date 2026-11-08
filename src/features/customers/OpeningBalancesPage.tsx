import { useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { toCsv } from "../../../shared/csv";
import { formatPkr } from "../../../shared/money";
import { openingBalanceColumns, openingBalanceTemplateRows } from "../../../shared/openingBalanceImport";
import { saveTextFile } from "../../api/client";
import { importOpeningBalances, previewOpeningBalances } from "../../api/customersApi";
import { ErrorMessage, PageTitle, SuccessMessage } from "../../app/FormElements";
import { IssuesTable } from "../products/IssuesTable";
import { useCsvImport } from "../products/useCsvImport";

/** Go-live: what each customer owed on the day the shop moved to this system, loaded from a CSV file. */
export function OpeningBalancesPage() {
  const queryClient = useQueryClient();
  const { fileName, preview, issues, result, error, busy, chooseFile, runImport } = useCsvImport({
    preview: previewOpeningBalances,
    run: importOpeningBalances,
    onImported: () => Promise.all(["customers", "customer-ledger", "customer-ageing", "customer-statement"].map((key) => queryClient.invalidateQueries({ queryKey: [key] }))),
  });

  return <div className="content">
    <PageTitle title="Customer opening balances" description="Load what each customer owed when you started using this system. It is done once per customer, before their first sale." />
    <p><Link className="text-button" to="/customers">← Back to customers</Link></p>
    <div className="two-column">
      <section className="panel stack">
        <h2>1. Choose a file</h2>
        <p className="muted">One row per customer. The customer must already exist. A positive balance is money they owe you; a negative one is credit you hold for them. The date sets how old the debt is in the ageing report.</p>
        <div className="button-row">
          <button className="button secondary" type="button" onClick={() => saveTextFile(toCsv(openingBalanceTemplateRows), "opening-balances-template.csv")}>Download template</button>
        </div>
        <label className="field"><span>CSV file</span><input className="input" type="file" accept=".csv,text/csv" onChange={(event) => void chooseFile(event)} disabled={busy} /></label>
        {fileName && <p className="muted">File: <strong>{fileName}</strong></p>}
        <details><summary>Columns</summary>
          <p className="mono">{openingBalanceColumns.join(", ")}</p>
          <p className="muted">Required: balance, and a customer (by name) or a phone. Use the phone when two customers share a name. date is yyyy-mm-dd and defaults to today. note is shown in the khata.</p>
        </details>
      </section>
      <section className="panel stack">
        <h2>2. Check and import</h2>
        {busy && <p className="muted" role="status">Working…</p>}
        {error && <ErrorMessage>{error}</ErrorMessage>}
        {result && <SuccessMessage>
          Opening balances loaded for {result.customers} customer{result.customers === 1 ? "" : "s"}: {formatPkr(result.owedPaisa)} owed to you
          {result.creditPaisa > 0 && `, ${formatPkr(result.creditPaisa)} credit held for customers`}.
        </SuccessMessage>}
        {preview && <>
          <p><strong>{preview.summary.customers}</strong> customer{preview.summary.customers === 1 ? "" : "s"} · {formatPkr(preview.summary.owedPaisa)} owed
            {preview.summary.creditPaisa > 0 && ` · ${formatPkr(preview.summary.creditPaisa)} credit`}</p>
          {preview.canImport
            ? <SuccessMessage>The file is valid.</SuccessMessage>
            : <ErrorMessage>{issues.length} problem{issues.length === 1 ? "" : "s"} found. Fix the file and choose it again.</ErrorMessage>}
          <button className="button primary" type="button" disabled={busy || !preview.canImport} onClick={() => void runImport()}>Load opening balances</button>
        </>}
        {!preview && !result && !busy && <p className="muted">Choose a file to see what would change.</p>}
      </section>
    </div>
    <IssuesTable issues={issues} />
  </div>;
}
