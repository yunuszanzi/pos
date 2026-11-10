import type { QuotationStatus } from "./schemas/quotations";

export const quotationStatusLabels: Record<QuotationStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  accepted: "Accepted",
  rejected: "Rejected",
  expired: "Expired",
  converted: "Converted",
  revised: "Replaced by a newer revision",
};

/** The message that goes with a quotation shared on WhatsApp. The person sends it; nothing is sent from the server. */
export function quotationShareMessage(input: { businessName: string; number: string; customerName: string; totalText: string; validUntilText: string }): string {
  return `Dear ${input.customerName}, ${input.businessName} quotation ${input.number} for ${input.totalText}, valid until ${input.validUntilText}.`;
}
