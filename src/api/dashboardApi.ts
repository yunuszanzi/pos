import { requestApi } from "./client";

/** Each section is present only if the person may see it. */
export type DashboardData = {
  date: string;
  sales?: { totalPaisa: number; bills: number; creditPaisa: number; averageBillPaisa: number; returnsPaisa: number; returns: number };
  profit?: { netSalesPaisa: number; costPaisa: number; grossProfitPaisa: number };
  topProducts?: Array<{ sku: string; product: string; quantity: string; totalPaisa: number }>;
  trend?: Array<{ day: string; totalPaisa: number; bills: number }>;
  cash?: { drawersPaisa?: number; openShifts?: number; accountsPaisa?: number };
  receivables?: { totalPaisa: number; customers: number };
  payables?: { totalPaisa: number; suppliers: number };
  lowStock?: { items: number };
};

export const getDashboard = (branchId?: string, signal?: AbortSignal) => requestApi<DashboardData>(`/dashboard${branchId ? `?branchId=${branchId}` : ""}`, { signal });
