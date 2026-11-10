import { useRef, useState, type ChangeEvent } from "react";
import { ApiRequestError } from "../../api/client";
import type { ImportIssue } from "../../api/productsApi";

type Checked = { canImport: boolean; issues: ImportIssue[] };

/**
 * The check-then-import flow shared by the CSV imports: choosing a file checks it (nothing is saved), the import
 * is only possible when the file is valid, and one Idempotency-Key per chosen file makes a retry safe.
 */
export function useCsvImport<TPreview extends Checked, TResult>(options: {
  preview: (csv: string) => Promise<TPreview>;
  run: (csv: string, idempotencyKey: string) => Promise<TResult>;
  onImported?: () => Promise<unknown> | void;
}) {
  const [fileName, setFileName] = useState("");
  const [csv, setCsv] = useState("");
  const [preview, setPreview] = useState<TPreview | null>(null);
  const [issues, setIssues] = useState<ImportIssue[]>([]);
  const [result, setResult] = useState<TResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
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
      const checked = await options.preview(text);
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
      setResult(await options.run(csv, idempotencyKey.current));
      setPreview(null);
      setIssues([]);
      await options.onImported?.();
    } catch (caught) {
      if (caught instanceof ApiRequestError && caught.code === "IMPORT_HAS_ERRORS") {
        const found = caught.details as ImportIssue[];
        setIssues(found);
        setPreview((current) => current && { ...current, canImport: false, issues: found });
      }
      setError(caught instanceof Error ? caught.message : "The import failed");
    } finally {
      setBusy(false);
    }
  }

  return { fileName, preview, issues, result, error, busy, chooseFile, runImport };
}
