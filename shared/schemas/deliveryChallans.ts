import { z } from "zod";
import { saleQuantitySchema } from "./sales";

const text = (max: number) => z.string().trim().max(max).default("");
const transport = {
  driverName: text(100),
  vehicleNo: text(30),
  route: text(200),
};

/**
 * A challan for part or all of what an order still has to deliver. Without `lines` everything not yet delivered (and not on another
 * pending challan) goes; with them each names an order line and how many, in the unit that line was ordered in.
 */
export const deliveryChallanSchema = z.object({
  orderId: z.string().uuid(),
  lines: z.array(z.object({ orderLineId: z.string().uuid(), quantity: saleQuantitySchema })).min(1).max(200).optional(),
  deliveryAddress: text(500),
  note: text(1000),
  ...transport,
});
export type DeliveryChallanInput = z.input<typeof deliveryChallanSchema>;

/** Who is taking it, in what, along which route. Any of them can be given or corrected at the moment of dispatch. */
export const dispatchSchema = z.object({
  driverName: z.string().trim().max(100).optional(),
  vehicleNo: z.string().trim().max(30).optional(),
  route: z.string().trim().max(200).optional(),
});
export type DispatchInput = z.input<typeof dispatchSchema>;

export const returnChallanSchema = z.object({ reason: z.string().trim().min(1, "Say why the goods came back").max(500) });

export const challanStatuses = ["pending", "dispatched", "delivered", "returned", "cancelled"] as const;
export type ChallanStatus = (typeof challanStatuses)[number];
export const challanStatusLabels: Record<ChallanStatus, string> = {
  pending: "Pending",
  dispatched: "Dispatched",
  delivered: "Delivered",
  returned: "Returned",
  cancelled: "Cancelled",
};
