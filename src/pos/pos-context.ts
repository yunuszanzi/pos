import { createContext, useContext } from "react";
import type { AppBootstrapData, Shift } from "../api/posApi";
import type { CatalogueIndex } from "./catalogueIndex";

export type PosContextValue = {
  data: AppBootstrapData;
  catalogue: CatalogueIndex;
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
