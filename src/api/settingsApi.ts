import { putJson, requestApi } from "./client";

export type BusinessSettings = {
  currency: "PKR";
  timezone: "Asia/Karachi";
  dateFormat: "dd/MM/yyyy" | "MM/dd/yyyy" | "yyyy-MM-dd";
  amountRounding: 2;
  sessionTimeoutMinutes: number;
  posSessionTimeoutHours: number;
  /** Paisa. Stock adjustments worth more than this need approval. */
  adjustmentApprovalThresholdPaisa: number;
  taxMode: "inclusive" | "exclusive";
  cashRoundingPaisa: 0 | 100 | 500 | 1000;
  allowNegativeStock: boolean;
  autoPrintReceipt: boolean;
  /** Days after a sale that goods can come back without a manager. */
  returnWindowDays: number;
};

export function getBusinessSettings() {
  return requestApi<BusinessSettings>("/settings");
}

export function updateBusinessSettings(settings: BusinessSettings) {
  return putJson<BusinessSettings>("/settings", settings);
}
