import { sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { fbrInvoiceProblems, fbrReferenceKinds, isTaxNumber, sandboxScenarios, type FbrReferenceKind } from "../../../shared/fbr";
import { fbrBuyerCheckSchema, fbrConfigSchema, fbrPaymentMethodSchema, fbrTaxCategorySchema, fbrTerminalSchema, fbrTokenSchema } from "../../../shared/schemas/fbr";
import { toDigitalInvoicingPayload } from "../../fbr/mapper";
import { adapterKind, clientFor, loadFbrSettings } from "../../fbr/config";
import { EncryptionKeyError, encryptSecret, tokenHint } from "../../fbr/crypto";
import { auditPrincipal } from "../../lib/audit";
import { db } from "../../lib/db";
import { apiError, paramId } from "../../lib/http";
import { getActorId, getPrincipal, requirePermission } from "../../lib/permissions";
import { validateJson } from "../../lib/validate";
import { escapeLike } from "../products/service";

// The FBR settings (FR-FBR-01..07). Looking is for those who may see the log; changing anything is the owner's alone.

export const fbrSettingsRoutes = new Hono();

const view = requirePermission("fbr.view");
const manage = requirePermission("fbr.manage");
const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : null);

/** The settings a screen may see: everything except the token, which is only ever "set" or "not set" with its last four characters. */
async function configView(businessId: string) {
  const settings = await loadFbrSettings(businessId);
  const [row] = await db.execute(sql`select * from fbr_config where business_id = ${businessId}`);
  const counts = await db.execute<{ kind: string; n: number }>(sql`select kind, count(*)::int as n from fbr_reference_data where business_id = ${businessId} group by kind`);
  const scenarios = await db.execute<{ scenario_id: string; passed: boolean; message: string; ran_at: string }>(sql`select scenario_id, passed, message, ran_at from fbr_scenario_runs where business_id = ${businessId}`);
  const passed = new Set(scenarios.filter((entry) => entry.passed).map((entry) => entry.scenario_id));
  return {
    enabled: settings.enabled, mode: settings.mode, environment: settings.environment,
    // What is stored, not the fallbacks, so the form shows what the owner typed; `suggested` is what the business profile would give.
    seller: {
      name: String(row?.seller_name ?? ""), ntn: String(row?.seller_ntn ?? ""), strn: String(row?.seller_strn ?? ""), province: String(row?.seller_province ?? ""), address: String(row?.seller_address ?? ""),
    },
    suggestedSeller: { name: settings.seller.name, ntn: settings.seller.ntnCnic, strn: settings.seller.strn, province: settings.seller.province, address: settings.seller.address },
    token: { set: settings.tokenSet, hint: row?.token_hint ? String(row.token_hint) : null, setAt: iso(row?.token_set_at) },
    cancelWindowHours: settings.cancelWindowHours, buyerIdThresholdPaisa: settings.buyerIdThresholdPaisa,
    lastTest: row?.last_test_at ? { at: iso(row.last_test_at), ok: Boolean(row.last_test_ok), message: String(row.last_test_message ?? "") } : null,
    lastSyncAt: iso(row?.last_sync_at),
    referenceCounts: Object.fromEntries(fbrReferenceKinds.map((kind) => [kind, Number(counts.find((entry) => entry.kind === kind)?.n ?? 0)])),
    scenarios: sandboxScenarios.map((scenario) => {
      const run = scenarios.find((entry) => entry.scenario_id === scenario.id);
      return { ...scenario, passed: run ? run.passed : null, message: run?.message ?? "", ranAt: iso(run?.ran_at) };
    }),
    allScenariosPassed: sandboxScenarios.every((scenario) => passed.has(scenario.id)),
    // "mock" means a built-in stand-in, not FBR: shown on the screen so nobody takes a test run for a real one.
    adapter: adapterKind(),
  };
}

fbrSettingsRoutes.get("/fbr/config", view, async (context) => context.json(await configView(getPrincipal(context).businessId!)));

/** What is still missing before FBR can be switched on. */
function notReady(settings: Awaited<ReturnType<typeof loadFbrSettings>>, input: { sellerNtn: string; sellerName: string; sellerProvince: string; sellerAddress: string }) {
  const problems: string[] = [];
  if (!settings.tokenSet) problems.push("Enter the FBR security token first");
  if (!input.sellerName.trim()) problems.push("Enter the seller's business name");
  if (!isTaxNumber(input.sellerNtn)) problems.push("Enter the seller's NTN");
  if (!input.sellerProvince.trim()) problems.push("Choose the seller's province");
  if (!input.sellerAddress.trim()) problems.push("Enter the seller's address");
  return problems;
}

fbrSettingsRoutes.put("/fbr/config", manage, validateJson(fbrConfigSchema), async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const input = context.req.valid("json");
  // POS fiscalisation uses a different FBR service from Digital Invoicing and is not built yet; saying so beats quietly not reporting.
  if (input.mode !== "di") return apiError(context, 422, "FBR_MODE_UNAVAILABLE", "Only Digital Invoicing is available in this version. POS fiscalisation is not built yet.");
  const current = await loadFbrSettings(businessId);
  const effective = { sellerNtn: input.sellerNtn || current.seller.ntnCnic, sellerName: input.sellerName || current.seller.name, sellerProvince: input.sellerProvince || current.seller.province, sellerAddress: input.sellerAddress || current.seller.address };

  if (input.enabled) {
    const problems = notReady(current, effective);
    if (problems.length) return apiError(context, 422, "FBR_NOT_READY", `FBR cannot be switched on yet. ${problems.join(". ")}.`);
  }
  // The sandbox pack exists so a business proves its set-up before real invoices go out (FR-FBR-06).
  if (input.environment === "production" && current.environment !== "production" && !input.confirmUntested) {
    const [{ passed }] = await db.execute<{ passed: number }>(sql`select count(*)::int as passed from fbr_scenario_runs where business_id = ${businessId} and passed`);
    if (passed < sandboxScenarios.length) {
      return apiError(context, 409, "SCENARIOS_NOT_PASSED", `Only ${passed} of the ${sandboxScenarios.length} sandbox test scenarios have passed. Run them in the sandbox first, or confirm that you want to go live without them.`);
    }
  }
  const actor = getActorId(principal);
  await db.execute(sql`
    insert into fbr_config (business_id, enabled, mode, environment, seller_ntn, seller_strn, seller_name, seller_province, seller_address, cancel_window_hours, buyer_id_threshold_paisa, updated_by)
    values (${businessId}, ${input.enabled}, ${input.mode}, ${input.environment}, ${input.sellerNtn}, ${input.sellerStrn}, ${input.sellerName}, ${input.sellerProvince}, ${input.sellerAddress}, ${input.cancelWindowHours}, ${input.buyerIdThresholdPaisa}, ${actor})
    on conflict (business_id) do update set enabled = excluded.enabled, mode = excluded.mode, environment = excluded.environment, seller_ntn = excluded.seller_ntn, seller_strn = excluded.seller_strn,
      seller_name = excluded.seller_name, seller_province = excluded.seller_province, seller_address = excluded.seller_address, cancel_window_hours = excluded.cancel_window_hours,
      buyer_id_threshold_paisa = excluded.buyer_id_threshold_paisa, updated_by = excluded.updated_by, updated_at = now(),
      -- A different environment is a different FBR: the last test says nothing about it.
      last_test_at = case when fbr_config.environment <> excluded.environment then null else fbr_config.last_test_at end,
      last_test_ok = case when fbr_config.environment <> excluded.environment then null else fbr_config.last_test_ok end,
      last_test_message = case when fbr_config.environment <> excluded.environment then null else fbr_config.last_test_message end`);
  await auditPrincipal(context, principal, "fbr_config", businessId, "update", { enabled: current.enabled, mode: current.mode, environment: current.environment },
    { enabled: input.enabled, mode: input.mode, environment: input.environment, sellerNtn: input.sellerNtn, cancelWindowHours: input.cancelWindowHours, confirmUntested: input.confirmUntested });
  return context.json(await configView(businessId));
});

/** Stores (or replaces) the token. It is encrypted before it is written and is never returned. */
fbrSettingsRoutes.put("/fbr/token", manage, validateJson(fbrTokenSchema), async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const { token } = context.req.valid("json");
  let encrypted: string;
  try {
    encrypted = encryptSecret(token);
  } catch (error) {
    if (error instanceof EncryptionKeyError) return apiError(context, 500, "ENCRYPTION_UNAVAILABLE", error.message);
    throw error;
  }
  await db.execute(sql`
    insert into fbr_config (business_id, token_encrypted, token_hint, token_set_at, updated_by) values (${businessId}, ${encrypted}, ${tokenHint(token)}, now(), ${getActorId(principal)})
    on conflict (business_id) do update set token_encrypted = excluded.token_encrypted, token_hint = excluded.token_hint, token_set_at = now(), updated_by = excluded.updated_by, updated_at = now(),
      last_test_at = null, last_test_ok = null, last_test_message = null`);
  // The log says that the token changed and which one it ends with, never the token.
  await auditPrincipal(context, principal, "fbr_config", businessId, "token_set", null, { hint: tokenHint(token) });
  return context.json(await configView(businessId));
});

fbrSettingsRoutes.delete("/fbr/token", manage, async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  await db.execute(sql`update fbr_config set token_encrypted = null, token_hint = null, token_set_at = null, enabled = false, last_test_at = null, last_test_ok = null, last_test_message = null, updated_by = ${getActorId(principal)}, updated_at = now() where business_id = ${businessId}`);
  await auditPrincipal(context, principal, "fbr_config", businessId, "token_removed", null, {});
  return context.json(await configView(businessId));
});

async function withClient(context: Context) {
  const businessId = getPrincipal(context).businessId!;
  const settings = await loadFbrSettings(businessId);
  try {
    const client = await clientFor(businessId, settings);
    if (!client) return { response: apiError(context, 409, "TOKEN_MISSING", "Enter the FBR security token first") };
    return { businessId, client, settings };
  } catch (error) {
    if (error instanceof EncryptionKeyError) return { response: apiError(context, 409, "TOKEN_UNREADABLE", error.message) };
    throw error;
  }
}

/** Runs one of PRAL's sandbox test scenarios (FR-FBR-06): a made-up invoice of that kind is checked by FBR's sandbox. Nothing is posted, so no real invoice number is used up. */
fbrSettingsRoutes.post("/fbr/scenarios/:scenarioId/run", manage, async (context) => {
  const scenario = sandboxScenarios.find((entry) => entry.id === context.req.param("scenarioId"));
  if (!scenario) return apiError(context, 404, "NOT_FOUND", "Unknown scenario");
  const ready = await withClient(context);
  if ("response" in ready) return ready.response;
  if (ready.settings.environment !== "sandbox") return apiError(context, 409, "NOT_SANDBOX", "Scenarios run against the FBR sandbox. Switch the environment to Sandbox first");
  const exempt = /exempt/i.test(scenario.saleType);
  const value = 100_000;
  const tax = exempt || scenario.rateBps === 0 ? 0 : Math.round((value * scenario.rateBps) / 10_000);
  const retail = !scenario.registered && scenario.id >= "SN026";
  const payload = toDigitalInvoicingPayload({
    kind: "sale", number: `TEST-${scenario.id}`, date: new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Karachi" }),
    seller: { name: ready.settings.seller.name, ntnCnic: ready.settings.seller.ntnCnic, strn: ready.settings.seller.strn, province: ready.settings.seller.province, address: ready.settings.seller.address },
    buyer: { name: scenario.registered ? "Test Buyer (Registered)" : "Walk-in customer", ntnCnic: scenario.registered ? "1234567" : "", province: ready.settings.seller.province, address: ready.settings.seller.address, registered: scenario.registered },
    lines: [{ hsCode: "9503.0090", description: "Scenario test item", uom: "Numbers, pieces, units", quantity: "1", valueExclTaxPaisa: value, taxPaisa: tax, totalPaisa: value + tax, discountPaisa: 0, rateBps: scenario.rateBps, saleType: scenario.saleType, sroScheduleNo: "", sroItemSerialNo: "" }],
    refIrn: null, totalPaisa: value + tax,
  }, "sandbox", { retail });
  const result = await ready.client.validate(payload);
  const passed = result.outcome === "valid";
  const message = passed ? "FBR's sandbox accepted the test invoice" : result.outcome === "rejected" ? `${result.code}: ${result.message}` : result.message;
  await db.execute(sql`
    insert into fbr_scenario_runs (business_id, scenario_id, passed, message, environment, ran_by) values (${ready.businessId}, ${scenario.id}, ${passed}, ${message}, 'sandbox', ${getActorId(getPrincipal(context))})
    on conflict (business_id, scenario_id) do update set passed = excluded.passed, message = excluded.message, environment = 'sandbox', ran_at = now(), ran_by = excluded.ran_by`);
  await auditPrincipal(context, getPrincipal(context), "fbr_config", ready.businessId, "scenario_run", null, { scenario: scenario.id, passed });
  return context.json({ id: scenario.id, passed, message });
});

fbrSettingsRoutes.post("/fbr/test", manage, async (context) => {
  const ready = await withClient(context);
  if ("response" in ready) return ready.response;
  const result = await ready.client.testConnection();
  await db.execute(sql`update fbr_config set last_test_at = now(), last_test_ok = ${result.ok}, last_test_message = ${result.message} where business_id = ${ready.businessId}`);
  await auditPrincipal(context, getPrincipal(context), "fbr_config", ready.businessId, "test", null, { ok: result.ok, environment: ready.settings.environment });
  return context.json({ ...result, environment: ready.settings.environment, adapter: adapterKind() });
});

/** Reads FBR's own lists into the system so codes can be checked against what FBR really has. */
fbrSettingsRoutes.post("/fbr/sync-reference", manage, async (context) => {
  const ready = await withClient(context);
  if ("response" in ready) return ready.response;
  const results: Array<{ kind: FbrReferenceKind; ok: boolean; count: number; message: string }> = [];
  for (const kind of fbrReferenceKinds) {
    const fetched = await ready.client.fetchReference(kind);
    if (!fetched.ok) { results.push({ kind, ok: false, count: 0, message: fetched.message }); continue; }
    await db.transaction(async (tx) => {
      // The list FBR gave replaces what was there: a code FBR no longer lists should not look valid.
      await tx.execute(sql`delete from fbr_reference_data where business_id = ${ready.businessId} and kind = ${kind}`);
      for (let at = 0; at < fetched.items.length; at += 500) {
        const chunk = fetched.items.slice(at, at + 500);
        await tx.execute(sql`
          insert into fbr_reference_data (business_id, kind, code, description, payload)
          values ${sql.join(chunk.map((item) => sql`(${ready.businessId}, ${kind}, ${item.code}, ${item.description}, ${JSON.stringify(item.payload)}::jsonb)`), sql`, `)}
          on conflict (business_id, kind, code) do update set description = excluded.description, payload = excluded.payload, synced_at = now()`);
      }
    });
    results.push({ kind, ok: true, count: fetched.items.length, message: "" });
  }
  if (results.some((result) => result.ok)) await db.execute(sql`update fbr_config set last_sync_at = now() where business_id = ${ready.businessId}`);
  await auditPrincipal(context, getPrincipal(context), "fbr_config", ready.businessId, "sync_reference", null, { results: results.map(({ kind, ok, count }) => ({ kind, ok, count })) });
  return context.json({ results });
});

fbrSettingsRoutes.get("/fbr/reference", view, async (context) => {
  const businessId = getPrincipal(context).businessId!;
  const kind = context.req.query("kind") as FbrReferenceKind;
  if (!fbrReferenceKinds.includes(kind)) return apiError(context, 400, "VALIDATION_FAILED", "Choose which list to look in");
  const search = context.req.query("q")?.trim().slice(0, 100);
  const page = Math.max(1, Math.trunc(Number(context.req.query("page") ?? 1)) || 1);
  const pageSize = Math.min(100, Math.max(1, Math.trunc(Number(context.req.query("pageSize") ?? 25)) || 25));
  const pattern = search ? `%${escapeLike(search)}%` : null;
  const rows = await db.execute(sql`
    select code, description, count(*) over () as total from fbr_reference_data
    where business_id = ${businessId} and kind = ${kind} ${pattern ? sql`and (code ilike ${pattern} or description ilike ${pattern})` : sql``}
    order by code limit ${pageSize} offset ${(page - 1) * pageSize}`);
  return context.json({ data: rows.map((row) => ({ code: String(row.code), description: String(row.description) })), page, pageSize, total: rows.length ? Number(rows[0].total) : 0 });
});

/** Is a buyer's registration number on FBR's list of registered persons? (FR-FBR-07) */
fbrSettingsRoutes.post("/fbr/verify-buyer", view, validateJson(fbrBuyerCheckSchema), async (context) => {
  const ready = await withClient(context);
  if ("response" in ready) return ready.response;
  return context.json(await ready.client.verifyBuyer(context.req.valid("json").registrationNo));
});

// ---------------------------------------------------------------- the mappings (FR-FBR-05)

fbrSettingsRoutes.get("/fbr/terminals", view, async (context) => {
  const rows = await db.execute(sql`select t.id, t.name, t.fbr_pos_id, t.fbr_enabled, t.active, b.name as branch_name from terminals t join branches b on b.id = t.branch_id where t.business_id = ${getPrincipal(context).businessId!} order by b.name, t.name`);
  return context.json({ data: rows.map((row) => ({ id: String(row.id), name: String(row.name), branchName: String(row.branch_name), fbrPosId: String(row.fbr_pos_id ?? ""), fbrEnabled: Boolean(row.fbr_enabled), active: Boolean(row.active) })) });
});
fbrSettingsRoutes.put("/fbr/terminals/:id", manage, validateJson(fbrTerminalSchema), async (context) => {
  const principal = getPrincipal(context);
  const input = context.req.valid("json");
  const [row] = await db.execute(sql`update terminals set fbr_pos_id = ${input.fbrPosId || null}, fbr_enabled = ${input.fbrEnabled}, updated_by = ${getActorId(principal)}, updated_at = now() where id = ${paramId(context)} and business_id = ${principal.businessId!} returning id`);
  if (!row) return apiError(context, 404, "NOT_FOUND", "Terminal not found");
  await auditPrincipal(context, principal, "terminal", String(row.id), "fbr_update", null, { fbrPosId: input.fbrPosId, fbrEnabled: input.fbrEnabled });
  return context.json({ ok: true });
});

fbrSettingsRoutes.get("/fbr/payment-methods", view, async (context) => {
  const rows = await db.execute(sql`select id, name, kind, fbr_payment_code, active from payment_methods where business_id = ${getPrincipal(context).businessId!} order by sort_order, name`);
  return context.json({ data: rows.map((row) => ({ id: String(row.id), name: String(row.name), kind: String(row.kind), fbrPaymentCode: String(row.fbr_payment_code ?? ""), active: Boolean(row.active) })) });
});
fbrSettingsRoutes.put("/fbr/payment-methods/:id", manage, validateJson(fbrPaymentMethodSchema), async (context) => {
  const principal = getPrincipal(context);
  const { fbrPaymentCode } = context.req.valid("json");
  const [row] = await db.execute(sql`update payment_methods set fbr_payment_code = ${fbrPaymentCode || null}, updated_by = ${getActorId(principal)}, updated_at = now() where id = ${paramId(context)} and business_id = ${principal.businessId!} returning id`);
  if (!row) return apiError(context, 404, "NOT_FOUND", "Payment method not found");
  await auditPrincipal(context, principal, "payment_method", String(row.id), "fbr_update", null, { fbrPaymentCode });
  return context.json({ ok: true });
});

fbrSettingsRoutes.get("/fbr/tax-categories", view, async (context) => {
  const rows = await db.execute(sql`select id, name, kind, rate_bps, fbr_sale_type, fbr_sro_schedule_no, fbr_sro_item_serial_no, active from tax_categories where business_id = ${getPrincipal(context).businessId!} order by rate_bps desc, name`);
  return context.json({ data: rows.map((row) => ({ id: String(row.id), name: String(row.name), kind: String(row.kind), rateBps: Number(row.rate_bps), fbrSaleType: String(row.fbr_sale_type ?? ""), sroScheduleNo: String(row.fbr_sro_schedule_no ?? ""), sroItemSerialNo: String(row.fbr_sro_item_serial_no ?? ""), active: Boolean(row.active) })) });
});
fbrSettingsRoutes.put("/fbr/tax-categories/:id", manage, validateJson(fbrTaxCategorySchema), async (context) => {
  const principal = getPrincipal(context);
  const input = context.req.valid("json");
  const [row] = await db.execute(sql`update tax_categories set fbr_sale_type = ${input.fbrSaleType || null}, fbr_sro_schedule_no = ${input.sroScheduleNo || null}, fbr_sro_item_serial_no = ${input.sroItemSerialNo || null}, updated_by = ${getActorId(principal)}, updated_at = now() where id = ${paramId(context)} and business_id = ${principal.businessId!} returning id`);
  if (!row) return apiError(context, 404, "NOT_FOUND", "Tax category not found");
  await auditPrincipal(context, principal, "tax_category", String(row.id), "fbr_update", null, input);
  return context.json({ ok: true });
});

/** What is not ready to be reported: the gaps in the mappings, with a few examples of each, so the owner knows what to fix before switching on. */
fbrSettingsRoutes.get("/fbr/readiness", view, async (context) => {
  const businessId = getPrincipal(context).businessId!;
  const settings = await loadFbrSettings(businessId);
  const sample = (rows: Array<Record<string, unknown>>, label: (row: Record<string, unknown>) => string) => rows.slice(0, 10).map(label);
  const noHs = await db.execute(sql`select p.name, count(*) over () as total from products p where p.business_id = ${businessId} and p.active and p.product_type <> 'service' and coalesce(btrim(p.hs_code), '') = '' order by p.name limit 10`);
  const noUom = await db.execute(sql`
    select p.name || coalesce(' — ' || nullif(v.variant_name, ''), '') as name, u.name as unit, count(*) over () as total
    from product_units pu join product_variants v on v.id = pu.variant_id join products p on p.id = v.product_id join units u on u.id = pu.unit_id
    where pu.business_id = ${businessId} and v.active and p.active and coalesce(btrim(pu.fbr_uom), '') = '' order by p.name limit 10`);
  const noSaleType = await db.execute(sql`
    select tc.name, count(*) over () as total from tax_categories tc
    where tc.business_id = ${businessId} and tc.active and coalesce(btrim(tc.fbr_sale_type), '') = '' and exists (select 1 from products p where p.tax_category_id = tc.id and p.active) order by tc.name limit 10`);
  const noPayment = await db.execute(sql`select name, count(*) over () as total from payment_methods where business_id = ${businessId} and active and coalesce(btrim(fbr_payment_code), '') = '' order by name limit 10`);
  const noNtn = await db.execute(sql`select name, count(*) over () as total from customers where business_id = ${businessId} and active and registered and coalesce(btrim(ntn), '') = '' order by name limit 10`);
  const noPosId = settings.mode === "di" ? [] : await db.execute(sql`select name, count(*) over () as total from terminals where business_id = ${businessId} and active and fbr_enabled and coalesce(btrim(fbr_pos_id), '') = '' order by name limit 10`);
  const total = (rows: Array<Record<string, unknown>>) => (rows.length ? Number(rows[0].total) : 0);
  const gaps = [
    { key: "hs_code", title: "Products with no HS code", total: total(noHs), examples: sample(noHs, (row) => String(row.name)), blocksSales: true },
    { key: "uom", title: "Product units with no FBR unit of measure", total: total(noUom), examples: sample(noUom, (row) => `${row.name} (${row.unit})`), blocksSales: true },
    { key: "sale_type", title: "Tax categories in use with no FBR sale type", total: total(noSaleType), examples: sample(noSaleType, (row) => String(row.name)), blocksSales: true },
    { key: "payment_code", title: "Payment methods with no FBR payment code", total: total(noPayment), examples: sample(noPayment, (row) => String(row.name)), blocksSales: false },
    { key: "buyer_ntn", title: "Registered customers with no NTN", total: total(noNtn), examples: sample(noNtn, (row) => String(row.name)), blocksSales: true },
    { key: "pos_id", title: "Terminals with no FBR POS ID", total: total(noPosId), examples: sample(noPosId, (row) => String(row.name)), blocksSales: true },
  ];
  const sellerProblems = fbrInvoiceProblems({
    kind: "sale", number: "", date: "", refIrn: null, totalPaisa: 0, buyer: { name: "", ntnCnic: "", province: "", address: "", registered: false },
    seller: { ...settings.seller, strn: settings.seller.strn }, lines: [],
  }, { buyerIdThresholdPaisa: settings.buyerIdThresholdPaisa }).filter((problem) => problem.startsWith("Enter the seller") || problem.startsWith("Choose the seller"));
  return context.json({ sellerProblems, gaps, ready: sellerProblems.length === 0 && gaps.every((gap) => !gap.blocksSales || gap.total === 0) });
});
