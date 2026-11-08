import type { DataVersions, ProductChanges } from "../api/posApi";
import type { PosCache } from "./catalogueCache";

type FetchChanges = (since: number, signal?: AbortSignal) => Promise<ProductChanges>;

/**
 * Brings the local catalogue up to date: asks for everything after the stored version and keeps asking while the server says
 * there is more. Each page is saved before the next is requested, so an interrupted first load resumes where it stopped.
 */
export async function syncCatalogue(cache: PosCache, fetchChanges: FetchChanges, signal?: AbortSignal): Promise<{ version: number; changed: number }> {
  let version = await cache.getVersion();
  let changed = 0;
  for (;;) {
    const page = await fetchChanges(version, signal);
    if (page.products.length || page.version !== version) await cache.applyChanges(page.products, page.version);
    changed += page.products.length;
    version = page.version;
    if (!page.hasMore) return { version, changed };
  }
}

/** Whether the server's counters say anything the till holds is out of date. A cheap check, so the till does not re-download on a timer. */
export function whatChanged(held: DataVersions, current: DataVersions): Array<keyof DataVersions> {
  return (Object.keys(current) as Array<keyof DataVersions>).filter((dataset) => current[dataset] !== held[dataset]);
}
