import type { Context } from "hono";
import { apiError } from "./http";

type PgError = { code?: string; constraint_name?: string; detail?: string; message?: string };

/** Drizzle wraps the driver error; the Postgres fields live on `cause`. */
function pgError(error: unknown): PgError {
  const wrapped = (error as { cause?: PgError } | null)?.cause;
  return wrapped ?? (error as PgError) ?? {};
}

/** The value in a Postgres "Key (a, b)=(x, y) already exists." detail: the last key column's value. */
function conflictingValue(detail: string | undefined): string {
  const values = /\)=\((.*)\) already exists/.exec(detail ?? "")?.[1];
  return values?.split(", ").at(-1) ?? "";
}

const duplicateMessages: Record<string, (value: string) => [code: string, message: string]> = {
  product_variants_sku_uidx: (value) => ["SKU_EXISTS", `SKU "${value}" is already used by another product`],
  product_units_barcode_uidx: (value) => ["BARCODE_EXISTS", `Barcode ${value} is already used by another product`],
  branches_business_id_code_key: () => ["CODE_EXISTS", "A branch with this code already exists"],
  categories_name_uidx: () => ["NAME_EXISTS", "A category with this name already exists here"],
  brands_name_uidx: () => ["NAME_EXISTS", "A brand with this name already exists"],
  tax_categories_name_uidx: () => ["NAME_EXISTS", "A tax category with this name already exists"],
  units_name_uidx: () => ["NAME_EXISTS", "A unit with this name already exists"],
  areas_name_uidx: () => ["NAME_EXISTS", "An area with this name already exists"],
  customer_groups_name_uidx: () => ["NAME_EXISTS", "A customer group with this name already exists"],
  customers_cnic_uidx: () => ["CNIC_EXISTS", "Another customer already has this CNIC"],
  cheques_identity_idx: () => ["CHEQUE_EXISTS", "This cheque has already been entered"],
  price_lists_name_uidx: () => ["NAME_EXISTS", "A price list with this name already exists"],
};

/** Answers a 409 for a duplicate-name/SKU/barcode violation, or returns null if the error is something else. */
export function duplicateConflict(context: Context, error: unknown) {
  const { code, constraint_name: constraint, detail } = pgError(error);
  if (code !== "23505") return null;
  const [errorCode, message] = duplicateMessages[constraint ?? ""]?.(conflictingValue(detail))
    ?? ["DUPLICATE", "This record already exists"];
  return apiError(context, 409, errorCode, message);
}

/** For catch blocks: answer a duplicate with 409, rethrow anything else so it becomes a 500. */
export function conflictOrThrow(context: Context, error: unknown): Response {
  const conflict = duplicateConflict(context, error);
  if (conflict) return conflict;
  throw error;
}

/** The message a Postgres function raised (RAISE EXCEPTION), for errors we raise on purpose such as STOCK_INSUFFICIENT. */
export function dbErrorMessage(error: unknown): string {
  return pgError(error).message ?? (error instanceof Error ? error.message : "");
}

/**
 * Postgres cancelled this request because it collided with another one (a deadlock, a serialization failure or a lock that
 * could not be taken). Nothing was saved, and trying again normally works.
 */
export function isTransientConflict(error: unknown): boolean {
  return ["40P01", "40001", "55P03"].includes(pgError(error).code ?? "");
}
