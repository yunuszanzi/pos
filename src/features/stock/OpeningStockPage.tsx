import { useQueryClient } from "@tanstack/react-query";
import { toCsv } from "../../../shared/csv";
import { formatPkr } from "../../../shared/money";
import { openingStockColumns, openingStockTemplateRows } from "../../../shared/openingStockImport";
import { saveTextFile } from "../../api/client";
import { importOpeningStock, previewOpeningStock } from "../../api/inventoryApi";
import { ErrorMessage, PageTitle, SuccessMessage } from "../../app/FormElements";
import { IssuesTable } from "../products/IssuesTable";
import { useCsvImport } from "../products/useCsvImport";
import { StockTabs } from "./StockTabs";

export function OpeningStockPage() {
  const queryClient = useQueryClient();
  const { fileName, preview, issues, result, error, busy, chooseFile, runImport } = useCsvImport({
    preview: previewOpeningStock,
    run: importOpeningStock,
    onImported: () => Promise.all(["stock", "adjustments", "ledger"].map((key) => queryClient.invalidateQueries({ queryKey: [key] }))),
  });

  return <div className="content">
    <PageTitle title="Opening stock" description="Load the stock you hold at go-live from a CSV file. Quantities can be in any unit the product is sold in: 10 cartons becomes 2,000 pieces." />
    <StockTabs />
    <div className="two-column">
      <section className="panel stack">
        <h2>1. Choose a file</h2>
        <p className="muted">One row per SKU. The SKU must already exist, and must not have any stock movements yet; use a stock adjustment after that.</p>
        <div className="button-row">
          <button className="button secondary" type="button" onClick={() => saveTextFile(toCsv(openingStockTemplateRows), "opening-stock-template.csv")}>Download template</button>
        </div>
        <label className="field"><span>CSV file</span><input className="input" type="file" accept=".csv,text/csv" onChange={(event) => void chooseFile(event)} disabled={busy} /></label>
        {fileName && <p className="muted">File: <strong>{fileName}</strong></p>}
        <details><summary>Columns</summary>
          <p className="mono">{openingStockColumns.join(", ")}</p>
          <p className="muted">Required: sku, quantity. unit defaults to the base unit. cost is per entered unit (per carton when the unit is Carton) and defaults to the SKU's cost. location is only needed when you have more than one.</p>
        </details>
      </section>
      <section className="panel stack">
        <h2>2. Check and import</h2>
        {busy && <p className="muted" role="status">Working…</p>}
        {error && <ErrorMessage>{error}</ErrorMessage>}
        {result && <SuccessMessage>
          Opening stock loaded: {result.lines} SKU{result.lines === 1 ? "" : "s"} in {result.locations} location{result.locations === 1 ? "" : "s"}
          {result.valuePaisa !== undefined && `, worth ${formatPkr(result.valuePaisa)} at cost`}.
        </SuccessMessage>}
        {preview && <>
          <p><strong>{preview.summary.lines}</strong> SKU{preview.summary.lines === 1 ? "" : "s"} in <strong>{preview.summary.locations}</strong> location{preview.summary.locations === 1 ? "" : "s"}</p>
          {preview.canImport
            ? <SuccessMessage>The file is valid.</SuccessMessage>
            : <ErrorMessage>{issues.length} problem{issues.length === 1 ? "" : "s"} found. Fix the file and choose it again.</ErrorMessage>}
          <button className="button primary" type="button" disabled={busy || !preview.canImport} onClick={() => void runImport()}>
            Load opening stock
          </button>
        </>}
        {!preview && !result && !busy && <p className="muted">Choose a file to see what would change.</p>}
      </section>
    </div>
    <IssuesTable issues={issues} />
  </div>;
}
