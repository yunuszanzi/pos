import { useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { toCsv } from "../../../shared/csv";
import { customerImportColumns, customerTemplateRows, supplierImportColumns, supplierTemplateRows, type PartyKind } from "../../../shared/partyImport";
import { saveTextFile } from "../../api/client";
import { previewPartyImport, runPartyImport } from "../../api/partyImportApi";
import { ErrorMessage, PageTitle, SuccessMessage } from "../../app/FormElements";
import { IssuesTable } from "../products/IssuesTable";
import { useCsvImport } from "../products/useCsvImport";

/** Go-live: the customers or suppliers the shop already deals with, loaded from a CSV file instead of typed in one by one. */
export function PartyImportPage({ kind }: { kind: PartyKind }) {
  const queryClient = useQueryClient();
  const customers = kind === "customer";
  const noun = customers ? "customer" : "supplier";
  const { fileName, preview, issues, result, error, busy, chooseFile, runImport } = useCsvImport({
    preview: (csv) => previewPartyImport(kind, csv),
    run: (csv, key) => runPartyImport(kind, csv, key),
    onImported: () => queryClient.invalidateQueries({ queryKey: [customers ? "customers" : "suppliers"] }),
  });
  const columns = customers ? customerImportColumns : supplierImportColumns;

  return <div className="content">
    <PageTitle title={`Import ${noun}s`} description={`Load the ${noun}s you already deal with from a spreadsheet. Nothing is saved until every row is fine.`} />
    <p><Link className="text-button" to={customers ? "/customers" : "/suppliers"}>← Back to {noun}s</Link></p>
    <div className="two-column">
      <section className="panel stack">
        <h2>1. Choose a file</h2>
        <p className="muted">One row per {noun}. Save your spreadsheet as CSV. {customers ? "A customer already held (same CNIC, or same name and phone) is refused." : "A supplier name already in use is refused."}</p>
        <div className="button-row">
          <button className="button secondary" type="button" onClick={() => saveTextFile(toCsv(customers ? customerTemplateRows : supplierTemplateRows), `${noun}s-template.csv`)}>Download template</button>
        </div>
        <label className="field"><span>CSV file</span><input className="input" type="file" accept=".csv,text/csv" onChange={(event) => void chooseFile(event)} disabled={busy} /></label>
        {fileName && <p className="muted">File: <strong>{fileName}</strong></p>}
        <details><summary>Columns</summary>
          <p className="mono">{columns.join(", ")}</p>
          <p className="muted">Only name is required. {customers ? "credit_limit is in rupees (50000.00); " : ""}registered is yes or no; terms_days is a whole number of days. Opening balances are loaded separately, after the {noun}s exist.</p>
        </details>
      </section>
      <section className="panel stack">
        <h2>2. Check and import</h2>
        {busy && <p className="muted" role="status">Working…</p>}
        {error && <ErrorMessage>{error}</ErrorMessage>}
        {result && <p className="notice success" role="status" data-testid="party-import-done">{result.imported} {noun}{result.imported === 1 ? "" : "s"} loaded.</p>}
        {preview && <>
          <p><strong>{preview.summary.rows}</strong> {noun}{preview.summary.rows === 1 ? "" : "s"} in the file</p>
          {preview.canImport
            ? <SuccessMessage>The file is valid.</SuccessMessage>
            : <ErrorMessage>{issues.length} problem{issues.length === 1 ? "" : "s"} found. Fix the file and choose it again.</ErrorMessage>}
          <button className="button primary" type="button" disabled={busy || !preview.canImport} onClick={() => void runImport()}>Load {noun}s</button>
        </>}
        {!preview && !result && !busy && <p className="muted">Choose a file to see what would be loaded.</p>}
      </section>
    </div>
    <IssuesTable issues={issues} />
  </div>;
}
