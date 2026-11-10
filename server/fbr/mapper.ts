import { fbrRateText, normaliseHsCode, scenarioFor, type FbrEnvironment, type FbrInvoiceInput } from "../../shared/fbr";
import { toPlainRupees } from "../../shared/money";

// Builds what PRAL's Digital Invoicing API wants from an invoice. Pure: no database and no network, so it is tested on its own.
// FBR takes amounts as JSON numbers in rupees. They come from whole paisa through the plain-rupees text, so no arithmetic is done on floats.

const rupees = (paisa: number) => Number(toPlainRupees(paisa));

export function toDigitalInvoicingPayload(invoice: FbrInvoiceInput, environment: FbrEnvironment, options: { retail: boolean }) {
  const first = invoice.lines[0];
  return {
    invoiceType: invoice.kind === "return" ? "Debit Note" : "Sale Invoice",
    invoiceDate: invoice.date,
    sellerNTNCNIC: invoice.seller.ntnCnic.replace(/\D/g, ""),
    sellerBusinessName: invoice.seller.name,
    sellerProvince: invoice.seller.province,
    sellerAddress: invoice.seller.address,
    buyerNTNCNIC: invoice.buyer.ntnCnic.replace(/\D/g, ""),
    buyerBusinessName: invoice.buyer.name,
    // A walk-in has no province on record; the sale happened in the seller's.
    buyerProvince: invoice.buyer.province || invoice.seller.province,
    buyerAddress: invoice.buyer.address || invoice.seller.address,
    buyerRegistrationType: invoice.buyer.registered ? "Registered" : "Unregistered",
    invoiceRefNo: invoice.kind === "return" ? invoice.refIrn ?? "" : "",
    // Only the sandbox asks which test scenario this invoice stands for.
    ...(environment === "sandbox" ? { scenarioId: scenarioFor(first?.saleType ?? "", invoice.buyer.registered, options.retail) } : {}),
    items: invoice.lines.map((line) => ({
      hsCode: normaliseHsCode(line.hsCode),
      productDescription: line.description,
      rate: fbrRateText(line.rateBps, line.saleType),
      uoM: line.uom,
      quantity: Number(line.quantity),
      totalValues: rupees(line.totalPaisa),
      valueSalesExcludingST: rupees(line.valueExclTaxPaisa),
      fixedNotifiedValueOrRetailPrice: 0,
      salesTaxApplicable: rupees(line.taxPaisa),
      salesTaxWithheldAtSource: 0,
      extraTax: "",
      furtherTax: 0,
      sroScheduleNo: line.sroScheduleNo,
      fedPayable: 0,
      discount: rupees(line.discountPaisa),
      saleType: line.saleType,
      sroItemSerialNo: line.sroItemSerialNo,
    })),
  };
}

export type DigitalInvoicingPayload = ReturnType<typeof toDigitalInvoicingPayload>;
