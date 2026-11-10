import type { FbrEnvironment } from "../../shared/fbr";
import { DigitalInvoicingAdapter } from "./adapters/digitalInvoicing";
import { MockAdapter } from "./adapters/mock";
import type { FbrClient } from "./types";

// The one place that decides which FBR the system talks to. FBR_ADAPTER=mock (development and tests) gives the stand-in; otherwise it is
// PRAL. A test can also hand in its own client for one run.

export type FbrClientFactory = (settings: { environment: FbrEnvironment; token: string; timeoutMs: number }) => FbrClient;

let override: FbrClientFactory | null = null;
/** For tests: use this client instead of the configured one until reset. */
export const setFbrClientFactory = (factory: FbrClientFactory | null) => { override = factory; };

export const defaultTimeoutMs = 12_000;

export function createFbrClient(settings: { environment: FbrEnvironment; token: string; timeoutMs?: number }): FbrClient {
  const full = { ...settings, timeoutMs: settings.timeoutMs ?? defaultTimeoutMs };
  if (override) return override(full);
  return process.env.FBR_ADAPTER === "mock" ? new MockAdapter(full) : new DigitalInvoicingAdapter(full);
}
