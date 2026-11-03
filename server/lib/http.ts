import type { Context } from "hono";

export function apiError(context: Context, status: 400 | 401 | 403 | 404 | 409 | 429 | 500 | 502, code: string, message: string) {
  return context.json({ error: { code, message } }, status);
}

export function parseFailure(context: Context, message: string) {
  return apiError(context, 400, "VALIDATION_FAILED", message);
}
