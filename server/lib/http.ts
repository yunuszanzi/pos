import type { Context } from "hono";

export function apiError(context: Context, status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 502, code: string, message: string) {
  return context.json({ error: { code, message } }, status);
}

export function roleAboveActor(context: Context) {
  return apiError(context, 403, "ROLE_ABOVE_ACTOR", "You cannot manage a role or user with permissions you do not have");
}

export function parseFailure(context: Context, message: string) {
  return apiError(context, 400, "VALIDATION_FAILED", message);
}

const nilUuid = "00000000-0000-0000-0000-000000000000";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A path parameter that is safe to use as a uuid. Anything else becomes the nil uuid, which matches no row (a 404), instead of a database error. */
export function paramId(context: Context, name = "id"): string {
  const value = context.req.param(name);
  return value && uuidPattern.test(value) ? value : nilUuid;
}
