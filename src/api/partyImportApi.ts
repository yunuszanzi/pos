import type { PartyKind } from "../../shared/partyImport";
import { postJson } from "./client";
import type { ImportIssue } from "./productsApi";

export type PartyImportPreview = { canImport: boolean; issues: ImportIssue[]; summary: { rows: number } };
export type PartyImportResult = { imported: number };

const base = (kind: PartyKind) => (kind === "customer" ? "/customers" : "/suppliers");
export const previewPartyImport = (kind: PartyKind, csv: string) => postJson<PartyImportPreview>(`${base(kind)}/import/preview`, { csv });
/** One Idempotency-Key per chosen file: a retry after a lost reply loads nobody twice. */
export const runPartyImport = (kind: PartyKind, csv: string, idempotencyKey: string) =>
  postJson<PartyImportResult>(`${base(kind)}/import`, { csv }, { "Idempotency-Key": idempotencyKey });
