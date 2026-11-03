import { describe, expect, it } from "vitest";
import { formatDocumentNumber } from "../../shared/documents";
import { PaymentError, settleTenders, type Tender } from "../../shared/payments";

const cash = (amountPaisa: number): Tender => ({ kind: "cash", amountPaisa });
const other = (amountPaisa: number): Tender => ({ kind: "other", amountPaisa });
const code = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error instanceof PaymentError ? error.code : "other";
  }
  return "no error";
};

describe("settleTenders", () => {
  it("takes exact cash", () => {
    expect(settleTenders(16815, [cash(16815)])).toMatchObject({ paidPaisa: 16815, changePaisa: 0, balancePaisa: 0 });
  });

  it("gives change from cash handed over", () => {
    const settled = settleTenders(16815, [cash(20000)]);
    expect(settled).toMatchObject({ paidPaisa: 16815, changePaisa: 3185, balancePaisa: 0 });
    expect(settled.tenders[0]).toEqual({ tenderedPaisa: 20000, appliedPaisa: 16815, changePaisa: 3185 });
  });

  it("splits between cash and a wallet: Rs 168.15 as Rs 100 JazzCash and the rest in cash", () => {
    const settled = settleTenders(16815, [other(10000), cash(10000)]);
    expect(settled.tenders).toEqual([
      { tenderedPaisa: 10000, appliedPaisa: 10000, changePaisa: 0 },
      { tenderedPaisa: 10000, appliedPaisa: 6815, changePaisa: 3185 },
    ]);
    expect(settled).toMatchObject({ paidPaisa: 16815, changePaisa: 3185, balancePaisa: 0 });
  });

  it("pays the whole bill by card or wallet", () => {
    expect(settleTenders(5000, [other(5000)])).toMatchObject({ paidPaisa: 5000, changePaisa: 0, balancePaisa: 0 });
    expect(settleTenders(5000, [other(2000), other(3000)])).toMatchObject({ paidPaisa: 5000, balancePaisa: 0 });
  });

  it("reports what is still owed when the payments fall short", () => {
    expect(settleTenders(5000, [cash(3000)])).toMatchObject({ paidPaisa: 3000, changePaisa: 0, balancePaisa: 2000 });
    expect(settleTenders(5000, [other(1000), cash(500)])).toMatchObject({ paidPaisa: 1500, balancePaisa: 3500 });
    expect(settleTenders(5000, [])).toMatchObject({ paidPaisa: 0, balancePaisa: 5000 });
  });

  it("applies several cash payments in order", () => {
    const settled = settleTenders(1500, [cash(1000), cash(1000)]);
    expect(settled.tenders).toEqual([
      { tenderedPaisa: 1000, appliedPaisa: 1000, changePaisa: 0 },
      { tenderedPaisa: 1000, appliedPaisa: 500, changePaisa: 500 },
    ]);
  });

  it("accepts a free bill with no payment", () => {
    expect(settleTenders(0, [])).toMatchObject({ paidPaisa: 0, changePaisa: 0, balancePaisa: 0 });
  });

  it("refuses a card or wallet payment above the bill: only cash gives change", () => {
    expect(code(() => settleTenders(5000, [other(5001)]))).toBe("OVERPAID_WITHOUT_CASH");
    expect(code(() => settleTenders(5000, [other(3000), other(2001)]))).toBe("OVERPAID_WITHOUT_CASH");
  });

  it("refuses cash that is not needed", () => {
    expect(code(() => settleTenders(5000, [other(5000), cash(100)]))).toBe("NOTHING_DUE");
    expect(code(() => settleTenders(1000, [cash(1000), cash(500)]))).toBe("NOTHING_DUE");
    expect(code(() => settleTenders(0, [cash(100)]))).toBe("NOTHING_DUE");
  });

  it("refuses payments that are not positive whole paisa", () => {
    for (const amount of [0, -5, 1.5, Number.NaN]) expect(code(() => settleTenders(5000, [cash(amount)]))).toBe("INVALID_TENDER");
    expect(code(() => settleTenders(-1, []))).toBe("INVALID_TENDER");
  });

  it("always splits the bill exactly: paid + balance = total, change = tendered - applied", () => {
    for (const total of [0, 1, 99, 5000, 123456]) {
      for (const tenders of [[cash(total + 7)], [other(Math.floor(total / 2)), cash(total)], [cash(Math.floor(total / 3) + 1)]]) {
        const valid = tenders.filter((tender) => tender.amountPaisa > 0);
        let settled;
        try {
          settled = settleTenders(total, valid);
        } catch (error) {
          expect(error).toBeInstanceOf(PaymentError);
          continue;
        }
        expect(settled.paidPaisa + settled.balancePaisa).toBe(total);
        expect(settled.tenders.reduce((sum, tender) => sum + tender.tenderedPaisa, 0) - settled.changePaisa).toBe(settled.paidPaisa);
      }
    }
  });
});

describe("formatDocumentNumber", () => {
  it("pads the sequence to six digits", () => {
    expect(formatDocumentNumber("INV-KHI", 1)).toBe("INV-KHI-000001");
    expect(formatDocumentNumber("INV-KHI", 123)).toBe("INV-KHI-000123");
    expect(formatDocumentNumber("INV", 1234567)).toBe("INV-1234567");
  });

  it("refuses a sequence that cannot exist", () => {
    for (const bad of [0, -1, 1.5]) expect(() => formatDocumentNumber("INV", bad)).toThrow(RangeError);
  });
});
