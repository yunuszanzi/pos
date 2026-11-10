import { createContext, useContext } from "react";
import type { AppBootstrapData, Shift } from "../api/posApi";
import type { TillCustomer } from "../api/customersApi";
import type { CatalogueIndex } from "./catalogueIndex";
import type { CustomerIndex } from "./customerIndex";

export type PosContextValue = {
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
