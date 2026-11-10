import { describe, expect, it } from "vitest";
import { fbrInvoiceProblems, fbrRateText, isHsCode, normaliseHsCode, retryDelayMinutes, scenarioFor, type FbrInvoiceInput } from "../../shared/fbr";
import { DigitalInvoicingAdapter } from "../../server/fbr/adapters/digitalInvoicing";
import { MockAdapter, mockCalls } from "../../server/fbr/adapters/mock";
import { decryptSecret, encryptSecret, EncryptionKeyError, tokenHint } from "../../server/fbr/crypto";
import { toDigitalInvoicingPayload } from "../../server/fbr/mapper";

const invoice = (overrides: Partial<FbrInvoiceInput> = {}): FbrInvoiceInput => ({
  kind: "sale", number: "INV-KHI-000042", date: "2026-11-10",
  seller: { name: "SGA Balloons", ntnCnic: "1234567-8", strn: "17-00-1234-567-89", province: "SINDH", address: "Shop 4, Saddar, Karachi" },
  buyer: { name: "Bilal Traders", ntnCnic: "7654321-1", province: "SINDH", address: "Jodia Bazaar", registered: true },
  lines: [{
    hsCode: "9503.0090", description: "Latex Balloon — Red", uom: "Numbers, pieces, units", quantity: "10", valueExclTaxPaisa: 4_237, taxPaisa: 763, totalPaisa: 5_000, discountPaisa: 0,
    rateBps: 1_800, saleType: "Goods at standard rate (default)", sroScheduleNo: "", sroItemSerialNo: "",
  }],
  refIrn: null, totalPaisa: 5_000, ...overrides,
});
const rules = { buyerIdThresholdPaisa: 5_000_000 };

describe("the FBR token is kept encrypted", () => {
  it("round-trips, never stores the token in the clear, and uses a fresh IV every time", () => {
    const stored = encryptSecret("eyJhbGciOi.secret-token");
    expect(stored).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(stored).not.toContain("secret-token");
    expect(decryptSecret(stored)).toBe("eyJhbGciOi.secret-token");
    expect(encryptSecret("eyJhbGciOi.secret-token")).not.toBe(stored);
    expect(tokenHint("eyJhbGciOi.secret-token")).toBe("••••oken");
  });

  it("notices any change to the stored text and a wrong key", () => {
    const stored = encryptSecret("a-token");
    const parts = stored.split(".");
    expect(() => decryptSecret([parts[0], parts[1], parts[2], `${parts[3].slice(0, -2)}AA`].join("."))).toThrow(EncryptionKeyError);
    expect(() => decryptSecret("not a token")).toThrow(EncryptionKeyError);
    const key = process.env.APP_ENCRYPTION_KEY;
    process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    expect(() => decryptSecret(stored)).toThrow(/cannot be read with this server's key/);
    process.env.APP_ENCRYPTION_KEY = Buffer.alloc(5).toString("base64");
    expect(() => encryptSecret("x")).toThrow(/32 random bytes/);
    delete process.env.APP_ENCRYPTION_KEY;
    expect(() => encryptSecret("x")).toThrow(/not set/);
    process.env.APP_ENCRYPTION_KEY = key;
  });
});

describe("what must be present before an invoice goes to FBR (FR-FBR-10)", () => {
  it("passes a complete registered sale", () => {
    expect(fbrInvoiceProblems(invoice(), rules)).toEqual([]);
  });

  it("names every missing piece in words the owner can act on", () => {
    const bare = invoice({
      seller: { name: "", ntnCnic: "", strn: "", province: "", address: "" },
      buyer: { name: "Bilal Traders", ntnCnic: "", province: "", address: "", registered: true },
      lines: [{ ...invoice().lines[0], hsCode: "", uom: "", saleType: "" }],
    });
    expect(fbrInvoiceProblems(bare, rules)).toEqual([
      "Enter the seller's business name in the FBR settings", "Enter the seller's NTN in the FBR settings", "Choose the seller's province in the FBR settings", "Enter the seller's address in the FBR settings",
      "Latex Balloon — Red: add its HS code (on the product)", "Latex Balloon — Red: add its FBR unit of measure (on the product's unit)", "Latex Balloon — Red: add the FBR sale type to its tax category",
      "Bilal Traders is registered for sales tax: add their NTN to the customer",
    ]);
    expect(fbrInvoiceProblems(invoice({ lines: [{ ...invoice().lines[0], hsCode: "95030090x" }] }), rules)).toEqual(['Latex Balloon — Red: the HS code "95030090x" should look like 9503.0090']);
    expect(fbrInvoiceProblems(invoice({ lines: [] }), rules)).toContain("The invoice has no items");
  });

  it("asks for the buyer's identity only for a large unregistered sale, and a return needs the original's number", () => {
    const walkIn = { name: "Walk-in", ntnCnic: "", province: "", address: "", registered: false };
    expect(fbrInvoiceProblems(invoice({ buyer: walkIn }), rules)).toEqual([]);
    expect(fbrInvoiceProblems(invoice({ buyer: walkIn, totalPaisa: 5_000_000 }), rules)).toEqual(["This sale is large enough that FBR needs the buyer's CNIC or NTN: choose the customer and add it to them"]);
    expect(fbrInvoiceProblems(invoice({ buyer: { ...walkIn, ntnCnic: "42101-1234567-1" }, totalPaisa: 5_000_000 }), rules)).toEqual([]);
    expect(fbrInvoiceProblems(invoice({ kind: "return" }), rules)).toEqual(["The invoice this return is against has not been accepted by FBR yet"]);
    expect(fbrInvoiceProblems(invoice({ kind: "return", refIrn: "1234567DI000000000001" }), rules)).toEqual([]);
  });

  it("recognises HS codes and writes the rate the way FBR does", () => {
    expect(normaliseHsCode("95030090")).toBe("9503.0090");
    expect(normaliseHsCode(" 9503.0090 ")).toBe("9503.0090");
    expect(isHsCode("9503.0090")).toBe(true);
    expect(isHsCode("9503")).toBe(false);
    expect(fbrRateText(1800, "Goods at standard rate (default)")).toBe("18%");
    expect(fbrRateText(750, "Goods at Reduced Rate")).toBe("7.5%");
    expect(fbrRateText(0, "Exempt goods")).toBe("Exempt");
  });
});

describe("retrying and the sandbox scenario", () => {
  it("backs off 1, 5, 15 and 60 minutes, then every hour", () => {
    expect([1, 2, 3, 4, 5, 9, 30].map(retryDelayMinutes)).toEqual([1, 5, 15, 60, 60, 60, 60]);
  });

  it("picks the sandbox scenario from what is sold and to whom", () => {
    expect(scenarioFor("Goods at standard rate (default)", true, false)).toBe("SN001");
    expect(scenarioFor("Goods at standard rate (default)", false, false)).toBe("SN002");
    expect(scenarioFor("Goods at standard rate (default)", false, true)).toBe("SN026");
    expect(scenarioFor("Goods at Reduced Rate", true, false)).toBe("SN005");
    expect(scenarioFor("Goods at Reduced Rate", false, true)).toBe("SN028");
    expect(scenarioFor("Exempt goods", true, true)).toBe("SN006");
    expect(scenarioFor("Goods at zero-rate", true, true)).toBe("SN007");
    expect(scenarioFor("3rd Schedule Goods", true, false)).toBe("SN008");
    expect(scenarioFor("3rd Schedule Goods", false, true)).toBe("SN027");
  });
});

describe("the Digital Invoicing payload", () => {
  it("is built from whole paisa with the field names PRAL expects, and the scenario only in the sandbox", () => {
    const payload = toDigitalInvoicingPayload(invoice(), "sandbox", { retail: false });
    expect(payload).toMatchObject({
      invoiceType: "Sale Invoice", invoiceDate: "2026-11-10", sellerNTNCNIC: "12345678", sellerBusinessName: "SGA Balloons", sellerProvince: "SINDH",
      buyerNTNCNIC: "76543211", buyerRegistrationType: "Registered", invoiceRefNo: "", scenarioId: "SN001",
    });
    expect(payload.items).toEqual([{
      hsCode: "9503.0090", productDescription: "Latex Balloon — Red", rate: "18%", uoM: "Numbers, pieces, units", quantity: 10, totalValues: 50, valueSalesExcludingST: 42.37,
      fixedNotifiedValueOrRetailPrice: 0, salesTaxApplicable: 7.63, salesTaxWithheldAtSource: 0, extraTax: "", furtherTax: 0, sroScheduleNo: "", fedPayable: 0, discount: 0,
      saleType: "Goods at standard rate (default)", sroItemSerialNo: "",
    }]);
    expect(toDigitalInvoicingPayload(invoice(), "production", { retail: false })).not.toHaveProperty("scenarioId");
  });

  it("makes a return a debit note that refers to the original's number, and fills in a walk-in's province from the seller's", () => {
    const payload = toDigitalInvoicingPayload(invoice({ kind: "return", refIrn: "1234567DI0001", buyer: { name: "Walk-in", ntnCnic: "", province: "", address: "", registered: false } }), "production", { retail: true });
    expect(payload).toMatchObject({ invoiceType: "Debit Note", invoiceRefNo: "1234567DI0001", buyerRegistrationType: "Unregistered", buyerProvince: "SINDH", buyerAddress: "Shop 4, Saddar, Karachi" });
  });
});

/** A fetch that answers with a canned reply, or fails the way the network does. */
const answer = (status: number, body: unknown): typeof fetch => (async () => ({ status, json: async () => body })) as unknown as typeof fetch;
const settings = { environment: "sandbox" as const, token: "tok", timeoutMs: 50 };

describe("the Digital Invoicing adapter sorts FBR's answers", () => {
  const accepted = { invoiceNumber: "1234567DI1747119701593", dated: "2026-11-10 12:01:41", validationResponse: { statusCode: "00", status: "Valid", error: "", invoiceStatuses: [{ itemSNo: "1", statusCode: "00", status: "Valid", invoiceNo: "1234567DI1747119701593-1", errorCode: "", error: "" }] } };

  it("takes a valid answer as accepted, with FBR's number", async () => {
    const result = await new DigitalInvoicingAdapter(settings, answer(200, accepted)).post({});
    expect(result).toMatchObject({ outcome: "accepted", irn: "1234567DI1747119701593", qrData: "1234567DI1747119701593", httpStatus: 200 });
    expect(await new DigitalInvoicingAdapter(settings, answer(200, accepted)).validate({})).toMatchObject({ outcome: "valid" });
  });

  it("reads why FBR refused an invoice, item by item", async () => {
    const refused = { validationResponse: { statusCode: "01", status: "Invalid", error: "", invoiceStatuses: [{ itemSNo: "2", statusCode: "01", status: "Invalid", errorCode: "0044", error: "Provided HS Code is invalid" }] } };
    expect(await new DigitalInvoicingAdapter(settings, answer(200, refused)).post({})).toMatchObject({ outcome: "rejected", code: "0044", message: "Item 2: Provided HS Code is invalid" });
    expect(await new DigitalInvoicingAdapter(settings, answer(400, { message: "Bad payload" })).validate({})).toMatchObject({ outcome: "rejected", message: "Bad payload" });
  });

  it("does not take an answer without an invoice number as accepted", async () => {
    const result = await new DigitalInvoicingAdapter(settings, answer(200, { validationResponse: { statusCode: "00", status: "Valid" } })).post({});
    expect(result).toMatchObject({ outcome: "rejected", code: "NO_IRN" });
    expect(await new DigitalInvoicingAdapter(settings, answer(200, null)).post({})).toMatchObject({ outcome: "rejected" });
  });

  it("keeps a refused token apart from FBR being down, and tries again only for the second", async () => {
    expect(await new DigitalInvoicingAdapter(settings, answer(401, {})).post({})).toMatchObject({ outcome: "unauthorised", httpStatus: 401 });
    expect(await new DigitalInvoicingAdapter(settings, answer(403, {})).validate({})).toMatchObject({ outcome: "unauthorised" });
    expect(await new DigitalInvoicingAdapter(settings, answer(503, {})).post({})).toMatchObject({ outcome: "transient", httpStatus: 503 });
    expect(await new DigitalInvoicingAdapter(settings, answer(429, {})).post({})).toMatchObject({ outcome: "transient" });
    const dead: typeof fetch = async () => { throw new TypeError("fetch failed"); };
    expect(await new DigitalInvoicingAdapter(settings, dead).post({})).toMatchObject({ outcome: "transient", message: expect.stringContaining("could not be reached") });
    const slow: typeof fetch = (_url, init) => new Promise((_resolve, reject) => { (init?.signal as AbortSignal).addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))); });
    expect(await new DigitalInvoicingAdapter(settings, slow).post({})).toMatchObject({ outcome: "transient", message: "FBR did not answer in time" });
  });

  it("sends the token as a bearer token to the right place for each environment, and nowhere else", async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const spy: typeof fetch = (async (url: string, init: RequestInit) => { seen.push({ url, auth: new Headers(init.headers).get("Authorization") }); return { status: 200, json: async () => accepted }; }) as unknown as typeof fetch;
    await new DigitalInvoicingAdapter({ ...settings, environment: "sandbox" }, spy).post({});
    await new DigitalInvoicingAdapter({ ...settings, environment: "production" }, spy).validate({});
    expect(seen).toEqual([
      { url: "https://gw.fbr.gov.pk/di_data/v1/di/postinvoicedata_sb", auth: "Bearer tok" },
      { url: "https://gw.fbr.gov.pk/di_data/v1/di/validateinvoicedata", auth: "Bearer tok" },
    ]);
  });

  it("tests a connection and reads the reference lists and a buyer's registration", async () => {
    expect(await new DigitalInvoicingAdapter(settings, answer(200, [])).testConnection()).toMatchObject({ ok: true });
    expect(await new DigitalInvoicingAdapter(settings, answer(401, {})).testConnection()).toMatchObject({ ok: false, message: expect.stringContaining("refused") });
    const provinces = await new DigitalInvoicingAdapter(settings, answer(200, [{ stateProvinceCode: 7, stateProvinceDesc: "SINDH" }, { stateProvinceCode: 1, stateProvinceDesc: "PUNJAB" }])).fetchReference("province");
    expect(provinces).toMatchObject({ ok: true, items: [{ code: "SINDH" }, { code: "PUNJAB" }] });
    expect(await new DigitalInvoicingAdapter(settings, answer(200, { notAList: true })).fetchReference("uom")).toMatchObject({ ok: false });
    expect(await new DigitalInvoicingAdapter(settings, answer(200, { REGISTRATION_STATUS: "Active", REGISTRATION_TYPE: "Registered" })).verifyBuyer("7654321-1")).toEqual({ ok: true, registered: true, message: "FBR lists this number as Registered" });
    expect(await new DigitalInvoicingAdapter(settings, answer(200, { REGISTRATION_TYPE: "Unregistered" })).verifyBuyer("7654321-1")).toMatchObject({ ok: true, registered: false });
  });
});

describe("the mock FBR behaves as its token says", () => {
  const payload = (hs = "9503.0090") => ({ invoiceType: "Sale Invoice", sellerNTNCNIC: "12345678", items: [{ hsCode: hs }] });
  it("accepts, and gives every invoice a number of its own, even two identical ones", async () => {
    const mock = new MockAdapter({ ...settings, token: "mock-ok" });
    const first = await mock.post(payload());
    const again = await mock.post(payload());
    expect(first).toMatchObject({ outcome: "accepted" });
    expect(again).toMatchObject({ outcome: "accepted", irn: expect.stringContaining("DI") });
    expect((again as { irn: string }).irn).not.toBe((first as { irn: string }).irn);
    expect(await mock.post({ ...payload(), invoiceType: "Debit Note" })).toMatchObject({ irn: expect.stringContaining("DN") });
    expect(mockCalls.filter((call) => call.kind === "post").length).toBeGreaterThanOrEqual(3);
  });

  it("can be told to be down, to refuse the token, or to reject; an HS code of zeros is always rejected", async () => {
    expect(await new MockAdapter({ ...settings, token: "mock-down" }).post(payload())).toMatchObject({ outcome: "transient" });
    expect(await new MockAdapter({ ...settings, token: "mock-auth" }).validate(payload())).toMatchObject({ outcome: "unauthorised" });
    expect(await new MockAdapter({ ...settings, token: "mock-reject" }).post(payload())).toMatchObject({ outcome: "rejected" });
    expect(await new MockAdapter({ ...settings, token: "mock-ok" }).post(payload("0000.0000"))).toMatchObject({ outcome: "rejected", code: "0044" });
    expect(await new MockAdapter({ ...settings, token: "mock-down" }).testConnection()).toMatchObject({ ok: false });
    expect(await new MockAdapter({ ...settings, token: "mock-ok" }).verifyBuyer("1234567-0")).toMatchObject({ ok: true, registered: false });
  });
});
