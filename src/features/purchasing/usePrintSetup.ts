import { useQuery } from "@tanstack/react-query";
import type { PrintFormat, ReceiptBusiness } from "../../../shared/receipt";
import { getAppBootstrapData } from "../../api/posApi";
import { useCan } from "../../app/permissions";
import { useTerminalStore } from "../../app/terminalStore";

export type PaymentMethodChoice = { id: string; code: string; name: string; kind: "cash" | "card" | "bank" | "wallet" };
export type PrintSetup = { business: ReceiptBusiness; dateFormat: string; timezone: string; defaultFormat: PrintFormat; paymentMethods: PaymentMethodChoice[] };

/**
 * The business details a printed document needs, from the same bootstrap call the till makes (shared by its cache key).
 * Undefined until they have loaded, and for people without the permission to sell, who cannot print from here.
 */
export function usePrintSetup(): PrintSetup | undefined {
  const maySell = useCan("sales.create");
  const terminalId = useTerminalStore((state) => state.terminalId);
  const setup = useQuery({ queryKey: ["pos-bootstrap", terminalId], queryFn: getAppBootstrapData, staleTime: Infinity, enabled: maySell });
  if (!setup.data) return undefined;
  return { business: setup.data.business, dateFormat: setup.data.settings.dateFormat, timezone: setup.data.settings.timezone, defaultFormat: setup.data.terminal?.defaultPrintFormat ?? "a4", paymentMethods: setup.data.paymentMethods };
}
