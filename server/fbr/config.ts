import { sql } from "drizzle-orm";
import type { FbrEnvironment, FbrMode } from "../../shared/fbr";
import { db } from "../lib/db";
import { createFbrClient } from "./client";
import { decryptSecret } from "./crypto";
import type { FbrClient } from "./types";

// A business's FBR settings as the server uses them. The token is decrypted here, for the moment of a call, and goes nowhere else.

export type FbrSettings = {
  businessId: string;
  enabled: boolean;
  mode: FbrMode;
  environment: FbrEnvironment;
  seller: { name: string; ntnCnic: string; strn: string; province: string; address: string };
  tokenSet: boolean;
  cancelWindowHours: number;
  buyerIdThresholdPaisa: number;
};

export async function loadFbrSettings(businessId: string): Promise<FbrSettings> {
  const [row] = await db.execute(sql`
    select c.*, b.trade_name, b.legal_name, b.ntn as b_ntn, b.strn as b_strn, b.address as b_address, b.province as b_province
    from businesses b left join fbr_config c on c.business_id = b.id where b.id = ${businessId}`);
  // Seller details left blank in the FBR settings fall back to the business profile.
  const pick = (own: unknown, fallback: unknown) => (String(own ?? "").trim() ? String(own) : String(fallback ?? ""));
  return {
    businessId,
    enabled: Boolean(row?.enabled),
    mode: (row?.mode ?? "di") as FbrMode,
    environment: (row?.environment ?? "sandbox") as FbrEnvironment,
    seller: {
      name: pick(row?.seller_name, row?.legal_name ?? row?.trade_name), ntnCnic: pick(row?.seller_ntn, row?.b_ntn), strn: pick(row?.seller_strn, row?.b_strn),
      province: pick(row?.seller_province, row?.b_province), address: pick(row?.seller_address, row?.b_address),
    },
    tokenSet: Boolean(row?.token_encrypted),
    cancelWindowHours: Number(row?.cancel_window_hours ?? 72),
    buyerIdThresholdPaisa: Number(row?.buyer_id_threshold_paisa ?? 5_000_000),
  };
}

/** The client for this business's environment and token, or null if no token is stored. The token is read and decrypted only here. */
export async function clientFor(businessId: string, settings?: FbrSettings, timeoutMs?: number): Promise<FbrClient | null> {
  const [row] = await db.execute<{ token_encrypted: string | null; environment: FbrEnvironment }>(sql`select token_encrypted, environment from fbr_config where business_id = ${businessId}`);
  if (!row?.token_encrypted) return null;
  return createFbrClient({ environment: settings?.environment ?? row.environment, token: decryptSecret(row.token_encrypted), timeoutMs });
}

export const adapterKind = () => (process.env.FBR_ADAPTER === "mock" ? "mock" : "live");
