import { PosCache } from "./catalogueCache";
import { useCartStore } from "./cartStore";

const scopeKey = "pos.cacheScope";

export const rememberCacheScope = (scope: string) => {
  try {
    localStorage.setItem(scopeKey, scope);
  } catch {
    // Without storage the scope cannot be remembered; the cache is still scoped to the user by its name.
  }
};

/** Signing out removes what this device kept about the business: the catalogue cache and any cart in progress. */
export async function wipeLocalPosData(): Promise<void> {
  useCartStore.getState().clear();
  try {
    const scope = localStorage.getItem(scopeKey);
    localStorage.removeItem(scopeKey);
    if (scope) await PosCache.destroy(scope);
  } catch {
    // Nothing more can be done; the next sign-in opens its own scope.
  }
}
