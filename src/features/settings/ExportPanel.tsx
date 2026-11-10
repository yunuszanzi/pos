import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { downloadApiFile } from "../../api/client";
import { getExportableTables } from "../../api/exportApi";
import { ErrorMessage } from "../../app/FormElements";

/** Your data is yours (FR-AUD-03): everything as one file, or any one table to open in a spreadsheet. */
export function ExportPanel() {
  const tables = useQuery({ queryKey: ["export-tables"], queryFn: getExportableTables, staleTime: 60_000 });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  async function download(path: string, name: string, label: string) {
    setError(""); setBusy(label);
    try {
      await downloadApiFile(path, name);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The download did not work");
    } finally {
      setBusy("");
    }
  }

  return <section className="panel stack" aria-label="Export your data">
    <h2>Export your data</h2>
    <p className="muted">Take everything the system holds about your business, whenever you like. Passwords, PINs and the FBR token are never included. Each download is recorded in the audit history.</p>
    {error && <ErrorMessage>{error}</ErrorMessage>}
    <div className="button-row">
      <button className="button primary" disabled={Boolean(busy)} onClick={() => void download("/export/data", "business-data.json", "all")}>{busy === "all" ? "Preparing…" : "Download everything (JSON)"}</button>
    </div>
    <details>
      <summary>One table at a time, for a spreadsheet (CSV)</summary>
      <ul className="role-list">
        {(tables.data?.data ?? []).map((table) => <li key={table.name}>
          <span><strong className="mono">{table.name}</strong><small>{table.rows.toLocaleString("en")} {table.rows === 1 ? "row" : "rows"}</small></span>
          <button className="text-button" disabled={Boolean(busy)} onClick={() => void download(`/export/data?format=csv&table=${table.name}`, `${table.name}.csv`, table.name)}>Download</button>
        </li>)}
      </ul>
    </details>
  </section>;
}
