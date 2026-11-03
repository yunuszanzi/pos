// @vitest-environment node
import { describe, expect, it } from "vitest";
import { callApi, createTestBusiness, hasLocalStack, sql } from "./helpers";

const integration = describe.skipIf(!hasLocalStack);

integration("money precision setting", { timeout: 60_000 }, () => {
  it("fixes amounts at 2 decimal places: the API and the database both refuse anything else", async () => {
    const business = await createTestBusiness();
    const settings = await callApi(business.ownerToken, "GET", "/settings");
    expect(settings.body.amountRounding).toBe(2);

    for (const amountRounding of [0, 1, 3]) {
      const response = await callApi(business.ownerToken, "PUT", "/settings", { body: { ...settings.body, amountRounding } });
      expect(response.status, `amountRounding ${amountRounding}`).toBe(400);
    }
    const kept = await callApi(business.ownerToken, "PUT", "/settings", { body: { ...settings.body, amountRounding: 2, dateFormat: "yyyy-MM-dd" } });
    expect(kept.status).toBe(200);
    expect(kept.body.amountRounding).toBe(2);

    const client = sql();
    try {
      await expect(client`UPDATE business_settings SET amount_rounding = 1 WHERE business_id = ${business.businessId}`).rejects.toThrow(/business_settings_amount_rounding_check/);
    } finally {
      await client.end();
    }
  });

  it("leaves a settings request without the field at 2 decimals", async () => {
    const business = await createTestBusiness();
    const settings = await callApi(business.ownerToken, "GET", "/settings");
    const { amountRounding: _omitted, ...withoutField } = settings.body;
    void _omitted;
    const response = await callApi(business.ownerToken, "PUT", "/settings", { body: withoutField });
    expect(response.status).toBe(200);
    expect(response.body.amountRounding).toBe(2);
  });
});
