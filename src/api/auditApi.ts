import { requestApi } from "./client";

export type AuditRecord = {
  id: string;
  entity: string;
  entityId: string;
  action: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  userId: string | null;
  terminalId: string | null;
  createdAt: string;
};

export function getAuditLog(page = 1, pageSize = 25) {
  return requestApi<{ data: AuditRecord[]; page: number; pageSize: number }>(`/audit-log?page=${page}&pageSize=${pageSize}`);
}
