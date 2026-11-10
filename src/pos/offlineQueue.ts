import type { PostSaleInput } from "../../shared/schemas/sales";
import { ApiRequestError, NetworkError } from "../api/client";
import type { PostedSale, SaleInvoice } from "../api/posApi";

// Sales rung up while the till had no connection (technical plan 5.5). Each is kept on this device, in the order it was made, with the
// Idempotency-Key it was first tried with, and sent when the connection returns. Sending the same one twice cannot post it twice.

export type QueuedSale = {
  /** Position in the queue: sales are sent in the order they were made. Set when stored. */
  seq?: number;
  /** What the slip called it (REGISTER1-OFF-000001). */
  offlineRef: string;
  idempotencyKey: string;
  terminalId: string;
  /** When it really happened. */
  soldAt: string;
  /** Exactly what is sent: the same body the first, online attempt carried, so a repeat is recognised as the same sale. */
  request: PostSaleInput;
  /** What the slip showed, kept so it can be printed again without a connection. */
  invoice: SaleInvoice;
  /** "failed" means the server refused it for a reason a person must look at; it stays here and is not retried on its own. */
  status: "queued" | "failed";
  attempts: number;
  lastError: string;
  lastErrorCode: string;
};

/** Where queued sales are kept. IndexedDB on the till; memory in tests. */
export interface OutboxStore {
  add(sale: Omit<QueuedSale, "seq">): Promise<number>;
  all(): Promise<QueuedSale[]>;
  update(seq: number, patch: Partial<Omit<QueuedSale, "seq">>): Promise<void>;
  remove(seq: number): Promise<void>;
  /** The next number for a terminal's slips: 1, 2, 3 … never reused, even after sales are sent. */
  nextNumber(terminalId: string): Promise<number>;
}

/** REGISTER1-OFF-000001: the terminal's name without spaces, then a counter. The server accepts letters, digits and dashes only. */
export function offlineReference(terminalName: string, number: number): string {
  const code = terminalName.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) || "TILL";
  return `${code}-OFF-${String(number).padStart(6, "0")}`;
}

const salesStore = "sales";
const metaStore = "meta";
const wait = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const finished = (transaction: IDBTransaction) => new Promise<void>((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error);
  transaction.onabort = () => reject(transaction.error ?? new Error("The offline sale could not be saved on this device"));
});

/** The name of the database: one per business and user, and never wiped on sign-out, because it holds sales not yet sent. */
export const outboxScope = (businessId: string, userId: string) => `pos-outbox:${businessId}:${userId}`;

export class IndexedDbOutbox implements OutboxStore {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(scope: string): Promise<IndexedDbOutbox> {
    const request = indexedDB.open(scope, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(salesStore)) request.result.createObjectStore(salesStore, { keyPath: "seq", autoIncrement: true });
      if (!request.result.objectStoreNames.contains(metaStore)) request.result.createObjectStore(metaStore);
    };
    return new IndexedDbOutbox(await wait(request));
  }

  close() {
    this.db.close();
  }

  async add(sale: Omit<QueuedSale, "seq">): Promise<number> {
    const transaction = this.db.transaction(salesStore, "readwrite");
    const key = await wait(transaction.objectStore(salesStore).add(sale));
    await finished(transaction);
    return Number(key);
  }

  async all(): Promise<QueuedSale[]> {
    const rows = await wait(this.db.transaction(salesStore).objectStore(salesStore).getAll() as IDBRequest<QueuedSale[]>);
    return rows.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  }

  async update(seq: number, patch: Partial<Omit<QueuedSale, "seq">>): Promise<void> {
    const transaction = this.db.transaction(salesStore, "readwrite");
    const store = transaction.objectStore(salesStore);
    const current = await wait(store.get(seq) as IDBRequest<QueuedSale | undefined>);
    if (current) store.put({ ...current, ...patch, seq });
    await finished(transaction);
  }

  async remove(seq: number): Promise<void> {
    const transaction = this.db.transaction(salesStore, "readwrite");
    transaction.objectStore(salesStore).delete(seq);
    await finished(transaction);
  }

  /** Counted in one transaction, so two tabs cannot hand out the same slip number. */
  async nextNumber(terminalId: string): Promise<number> {
    const transaction = this.db.transaction(metaStore, "readwrite");
    const store = transaction.objectStore(metaStore);
    const key = `counter:${terminalId}`;
    const current = await wait(store.get(key) as IDBRequest<number | undefined>);
    const next = (typeof current === "number" ? current : 0) + 1;
    store.put(next, key);
    await finished(transaction);
    return next;
  }
}

export type SendResult = {
  /** Posted, with the number the books gave them. */
  sent: Array<{ item: QueuedSale; sale: PostedSale }>;
  /** Refused by the server for a reason a person must look at. */
  refused: QueuedSale[];
  /** True when the connection or the sign-in stopped it; what is left is tried again later. */
  stopped: boolean;
};

/**
 * Sends the queue in the order the sales were made. A lost connection stops the run (what is left keeps its place); a sale the server
 * refuses is marked and the run goes on with the next, so one bad sale does not hold up the rest.
 */
export async function sendQueuedSales(store: OutboxStore, send: (item: QueuedSale) => Promise<PostedSale>): Promise<SendResult> {
  const result: SendResult = { sent: [], refused: [], stopped: false };
  for (const item of (await store.all()).filter((entry) => entry.status === "queued")) {
    try {
      const sale = await send(item);
      await store.remove(item.seq!);
      result.sent.push({ item, sale });
    } catch (caught) {
      if (caught instanceof NetworkError || (caught instanceof ApiRequestError && (caught.status === 401 || caught.status >= 500))) {
        await store.update(item.seq!, { attempts: item.attempts + 1, lastError: caught.message });
        result.stopped = true;
        return result;
      }
      const code = caught instanceof ApiRequestError ? caught.code ?? "" : "";
      const message = caught instanceof Error ? caught.message : "The sale could not be sent";
      await store.update(item.seq!, { status: "failed", attempts: item.attempts + 1, lastError: message, lastErrorCode: code });
      result.refused.push({ ...item, status: "failed", lastError: message, lastErrorCode: code });
    }
  }
  return result;
}
