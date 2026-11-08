import { z } from "zod";

/** A parked cart. The server keeps it as given (the till's own shape) and only limits its size; it is priced again when it is sold. */
export const holdSaleSchema = z.object({
  name: z.string().trim().max(100).default(""),
  cart: z.unknown().refine((value) => value !== undefined && value !== null && JSON.stringify(value).length <= 200_000, "The cart is empty or too large"),
  totalPaisa: z.number().int().min(0).max(100_000_000_000_000),
});

export const maxHeldSalesPerTerminal = 50;
