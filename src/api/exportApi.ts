import { requestApi } from "./client";

export type ExportableTable = { name: string; rows: number };
export const getExportableTables = () => requestApi<{ data: ExportableTable[] }>("/export/tables");
