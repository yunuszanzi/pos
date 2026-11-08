import type { Product } from "../api/productsApi";

const productsStore = "products";
const metaStore = "meta";
const versionKey = "catalogueVersion";

const wait = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const finished = (transaction: IDBTransaction) => new Promise<void>((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error);
  transaction.onabort = () => reject(transaction.error ?? new Error("The local cache write was cancelled"));
});

/** The name of the database for one business and user: the cache is never shared between people (technical-plan 5.7). */
export const cacheScope = (businessId: string, userId: string) => `pos-cache:${businessId}:${userId}`;

/** The product catalogue kept in IndexedDB so the till starts instantly and syncs only what changed. */
export class PosCache {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(scope: string): Promise<PosCache> {
    const request = indexedDB.open(scope, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(productsStore, { keyPath: "id" });
      request.result.createObjectStore(metaStore);
    };
    return new PosCache(await wait(request));
  }

  /** Wipes a scope, for sign-out. */
  static destroy(scope: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(scope);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => resolve();
    });
  }

  close() {
    this.db.close();
  }

  async getVersion(): Promise<number> {
    const stored = await wait(this.db.transaction(metaStore).objectStore(metaStore).get(versionKey));
    return typeof stored === "number" ? stored : 0;
  }

  getProducts(): Promise<Product[]> {
    return wait(this.db.transaction(productsStore).objectStore(productsStore).getAll() as IDBRequest<Product[]>);
  }

  /** Stores changed products, drops archived ones, and moves the version, all in one transaction so a crash cannot leave a half-applied sync. */
  async applyChanges(changed: Product[], version: number): Promise<void> {
    const transaction = this.db.transaction([productsStore, metaStore], "readwrite");
    const products = transaction.objectStore(productsStore);
    for (const product of changed) {
      if (product.active) products.put(product);
      else products.delete(product.id);
    }
    transaction.objectStore(metaStore).put(version, versionKey);
    await finished(transaction);
  }

  async clear(): Promise<void> {
    const transaction = this.db.transaction([productsStore, metaStore], "readwrite");
    transaction.objectStore(productsStore).clear();
    transaction.objectStore(metaStore).clear();
    await finished(transaction);
  }
}
