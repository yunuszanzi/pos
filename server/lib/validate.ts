import { zValidator } from "@hono/zod-validator";
import type { ZodType } from "zod";

/** Validates the JSON body and fails with the standard `{ error: { code, message, details } }` shape. */
export function validateJson<T extends ZodType>(schema: T) {
  return zValidator("json", schema, (result, context) => {
    if (result.success) return;
    const [first] = result.error.issues;
    const field = first?.path.join(".");
    return context.json({
      error: {
        code: "VALIDATION_FAILED",
        message: first ? `${field ? `${field}: ` : ""}${first.message}` : "The request is invalid",
        details: result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      },
    }, 400);
  });
}
