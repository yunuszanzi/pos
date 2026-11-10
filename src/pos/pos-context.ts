import { createContext, useContext } from "react";
import type { AppBootstrapData, Shift } from "../api/posApi";
import type { TillCustomer } from "../api/customersApi";
import type { CatalogueIndex } from "./catalogueIndex";
import type { CustomerIndex } from "./customerIndex";
import type { QueuedSale } from "./offlineQueue";

/** Sales rung up without a connection (technical plan 5.5): kept on this device and sent, in order, when the connection returns. */
export type OfflineState = {
  /** False when the browser says it is offline, or the server could not be reached. */
  online: boolean;
  /** Waiting to be sent, oldest first. */
  queued: QueuedSale[];
  /** Refused by the server for a reason a person must look at; they stay here until fixed and retried. */
  refused: QueuedSale[];
  /** The last run that sent sales: how many, and the numbers the books gave them. */
  lastSent: { count: number; numbers: string[] } | null;
  /** The slip reference for the next offline sale on this terminal (REGISTER1-OFF-000001). */
  nextReference: () => Promise<string>;
  /** Keeps a sale on this device to be sent later. */
  save: (sale: Omit<QueuedSale, "seq" | "status" | "attempts" | "lastError" | "lastErrorCode">) => Promise<void>;
  /** The server could not be reached: the till treats itself as offline until something gets through. */
  markUnreachable: () => void;
  sendNow: () => Promise<void>;
  /** Puts a refused sale back in the queue to be sent again, after whatever was wrong has been put right. */
  retry: (seq: number) => Promise<void>;
};

export type PosContextValue = {
  offline: OfflineState;
  data: AppBootstrapData;
  catalogue: CatalogueIndex;
  /** The customers held on this till; searched locally. */
  customers: CustomerIndex;
  /** Puts a customer just added at the till into the local list, so no re-download is needed. */
  rememberCustomer: (customer: TillCustomer) => void;
  /** "syncing" while the catalogue is being brought up to date; the till is usable from what is already held. */
  catalogueStatus: "loading" | "syncing" | "ready" | "error";
  catalogueError: string;
  shift: AppBootstrapData["shift"];
  setShift: (shift: Pick<Shift, "id" | "openedAt" | "openingFloatPaisa"> | null) => void;
  /** Stock after the latest sales, from their responses (the server re-checks on posting). Base units, as text. */
  stockOnHand: ReadonlyMap<string, string>;
  applyStock: (levels: Array<{ variantId: string; onHand: string }>) => void;
  can: (permission: string) => boolean;
  syncNow: () => Promise<void>;
};

export const PosContext = createContext<PosContextValue | null>(null);

export function usePos() {
  const value = useContext(PosContext);
  if (!value) throw new Error("usePos must be used within PosProvider");
  return value;
}
