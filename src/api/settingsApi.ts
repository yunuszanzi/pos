import { putJson, requestApi } from "./client";

export type BusinessSettings = {
  currency: "PKR";
  timezone: "Asia/Karachi";
  dateFormat: "dd/MM/yyyy" | "MM/dd/yyyy" | "yyyy-MM-dd";
  amountRounding: number;
  sessionTimeoutMinutes: number;
  posSessionTimeoutHours: number;
};

export function getBusinessSettings() {
  return requestApi<BusinessSettings>("/settings");
}

export function updateBusinessSettings(settings: BusinessSettings) {
  return putJson<BusinessSettings>("/settings", settings);
}
