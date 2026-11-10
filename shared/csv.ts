// Minimal RFC 4180 CSV reader/writer for product import and export. Comma-delimited, as Excel saves it.

export class CsvError extends Error {}

/** Parses CSV text into rows of cells. Handles a UTF-8 BOM, CRLF/LF, quoted cells with commas, newlines and "" escapes. Blank lines are skipped. */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let cellStarted = false;

  const endCell = () => {
    row.push(cell);
    cell = "";
    cellStarted = false;
  };
  const endRow = () => {
    endCell();
    if (row.length > 1 || row[0].trim() !== "") rows.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"' && !cellStarted) {
      quoted = true;
      cellStarted = true;
    } else if (char === '"') {
      throw new CsvError(`Unexpected quote in the middle of a cell (row ${rows.length + 1})`);
    } else if (char === ",") {
      endCell();
    } else if (char === "\r") {
      if (text[index + 1] === "\n") index += 1;
      endRow();
    } else if (char === "\n") {
      endRow();
    } else {
      cell += char;
      cellStarted = true;
    }
  }
  if (quoted) throw new CsvError("A quoted cell is never closed");
  if (cellStarted || cell !== "" || row.length > 0) endRow();
  return rows;
}

/** Prefixes cells a spreadsheet would run as a formula, so exported data cannot execute in Excel. */
export function neutraliseFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

export function toCsv(rows: ReadonlyArray<ReadonlyArray<string | number | null | undefined>>): string {
  return rows.map((row) => row.map((value) => {
    const text = typeof value === "number" ? String(value) : neutraliseFormula(value ?? "");
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }).join(",")).join("\r\n") + "\r\n";
}

/** First row is the header. Header names are lower-cased, trimmed and spaces become underscores. */
export function csvToRecords(rows: string[][]): { headers: string[]; records: Array<Record<string, string>> } {
  if (!rows.length) throw new CsvError("The file is empty");
  const headers = rows[0].map((header) => header.trim().toLowerCase().replace(/\s+/g, "_"));
  const duplicate = headers.find((header, position) => header && headers.indexOf(header) !== position);
  if (duplicate) throw new CsvError(`The column "${duplicate}" appears twice`);
  const records = rows.slice(1).map((cells) => Object.fromEntries(
    headers.map((header, position) => [header, (cells[position] ?? "").trim()]),
  ));
  return { headers, records };
}
