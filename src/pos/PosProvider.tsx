import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { getCustomerChangesSince, type TillCustomer } from "../api/customersApi";
import { getAppBootstrapData, getDataVersions, getProductChangesSince, getStockLevelsForProducts, postSaleInvoice, type AppBootstrapData, type DataVersions } from "../api/posApi";
import type { Product } from "../api/productsApi";
import { NetworkError } from "../api/client";
import { useTerminalStore } from "../app/terminalStore";
import { keepCopy, readCopy } from "./offlineCache";
import { PosCache, cacheScope } from "./catalogueCache";
import { CatalogueIndex } from "./catalogueIndex";
import { syncCatalogue, syncCustomers, whatChanged } from "./catalogueSync";
import { CustomerIndex } from "./customerIndex";
import { rememberCacheScope } from "./localData";
import { IndexedDbOutbox, offlineReference, outboxScope, sendQueuedSales, type QueuedSale } from "./offlineQueue";
import { PosContext, type PosContextValue } from "./pos-context";

const checkEveryMs = 5 * 60_000;
/** How often queued offline sales are tried again while there are any. */
const resendEveryMs = 20_000;

/** Loads what the till needs once (technical-plan 5.7): bootstrap data, then the catalogue from the local cache, then only what changed. */
export function PosProvider({ children }: { children: ReactNode }) {
  const terminalId = useTerminalStore((state) => state.terminalId);
  const bootstrap = useQuery({
    queryKey: ["pos-bootstrap", terminalId],
    queryFn: async () => {
      try {
        const fresh = await getAppBootstrapData();
        keepCopy(`bootstrap:${terminalId}`, fresh);
        return fresh;
      } catch (caught) {
        // The till is opened with no connection: start from what it was told last time, so selling can go on.
        const kept = caught instanceof NetworkError ? readCopy<AppBootstrapData>(`bootstrap:${terminalId}`) : null;
        if (kept) return kept;
        throw caught;
      }
    },
    staleTime: Infinity,
    gcTime: Infinity,
    retry: 1,
  });
  const { refetch } = bootstrap;
  const reload = useCallback(async () => { await refetch(); }, [refetch]);
  if (bootstrap.isPending) return <div className="full-message">Opening the till…</div>;
  if (bootstrap.isError) {
    return <div className="full-message"><div className="stack"><p className="notice error">{bootstrap.error.message}</p><button className="button primary" onClick={() => void bootstrap.refetch()}>Try again</button></div></div>;
  }
  return <Loaded data={bootstrap.data} reloadBootstrap={reload}>{children}</Loaded>;
}

function Loaded({ data, reloadBootstrap, children }: { data: AppBootstrapData; reloadBootstrap: () => Promise<void>; children: ReactNode }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [status, setStatus] = useState<PosContextValue["catalogueStatus"]>("loading");
  const [error, setError] = useState("");
  const [customerList, setCustomerList] = useState<TillCustomer[]>([]);
  const [shift, setShift] = useState(data.shift);
  const [stock, setStock] = useState<ReadonlyMap<string, string>>(new Map());
  const cacheRef = useRef<PosCache | null>(null);
  const versionsRef = useRef<DataVersions>(data.versions);
  const syncing = useRef(false);
  const productsRef = useRef<Product[]>([]);
  const stockLoaded = useRef(false);
  const outboxRef = useRef<IndexedDbOutbox | null>(null);
  const sending = useRef(false);
  const [browserOnline, setBrowserOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine);
  const [reachable, setReachable] = useState(true);
  const [outbox, setOutbox] = useState<QueuedSale[]>([]);
  const [lastSent, setLastSent] = useState<{ count: number; numbers: string[] } | null>(null);

  const scope = cacheScope(data.business.id, data.user.id);
  const mayReadCustomers = data.user.permissions.includes("*") || data.user.permissions.includes("customers.view");
  const stockLocation = data.terminal.salesLocationId;
  const mayReadStock = data.user.permissions.includes("*") || data.user.permissions.includes("inventory.view");

  /** What is on the shelf, for up to 500 stocked SKUs in one call. A failure leaves the old figures; the server checks stock on posting anyway. */
  const refreshStock = useCallback(async () => {
    if (!stockLocation || !mayReadStock) return;
    const ids = productsRef.current.filter((product) => product.productType === "stocked")
      .flatMap((product) => product.variants.filter((variant) => variant.active).map((variant) => variant.id)).slice(0, 500);
    if (!ids.length) return;
    try {
      const levels = await getStockLevelsForProducts(ids, stockLocation);
      setStock(new Map(levels.map((level) => [level.variantId, level.onHand])));
    } catch {
      // Keep what is shown.
    }
  }, [stockLocation, mayReadStock]);

  /** Customers by version, like the catalogue. A failure keeps the list the till already holds. */
  const syncCustomerList = useCallback(async () => {
    const cache = cacheRef.current;
    if (!cache || !mayReadCustomers) return;
    try {
      const { changed } = await syncCustomers(cache, getCustomerChangesSince);
      if (changed) setCustomerList(await cache.getCustomers());
    } catch {
      // The next version check tries again.
    }
  }, [mayReadCustomers]);

  const sync = useCallback(async () => {
    const cache = cacheRef.current;
    if (!cache || syncing.current) return;
    syncing.current = true;
    setStatus((current) => (current === "ready" ? "syncing" : current));
    try {
      const { changed } = await syncCatalogue(cache, getProductChangesSince);
      if (changed) setProducts(await cache.getProducts());
      setStatus("ready");
      setError("");
    } catch (caught) {
      // The cache already holds the last good state, so selling goes on; only say the update failed.
      setStatus((current) => (current === "loading" ? "error" : "ready"));
      setError(caught instanceof Error ? caught.message : "The product list could not be updated");
    } finally {
      syncing.current = false;
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const cache = await PosCache.open(scope);
        if (!alive) return cache.close();
        cacheRef.current = cache;
        rememberCacheScope(scope);
        setProducts(await cache.getProducts());
        setCustomerList(await cache.getCustomers());
        setStatus("syncing");
        await sync();
        await syncCustomerList();
      } catch (caught) {
        if (alive) {
          setStatus("error");
          setError(caught instanceof Error ? caught.message : "The local product list could not be opened");
        }
      }
    })();
    return () => {
      alive = false;
      cacheRef.current?.close();
      cacheRef.current = null;
    };
  }, [scope, sync, syncCustomerList]);

  // A tiny version check, on focus and every five minutes, decides what (if anything) is downloaded again.
  useEffect(() => {
    let busy = false;
    const check = async () => {
      if (busy || document.visibilityState === "hidden") return;
      busy = true;
      try {
        const current = await getDataVersions();
        const changed = whatChanged(versionsRef.current, current);
        versionsRef.current = current;
        if (changed.includes("catalogue")) await sync();
        await refreshStock();
        if (changed.includes("customers")) await syncCustomerList();
        if (changed.some((dataset) => dataset !== "catalogue" && dataset !== "customers")) await reloadBootstrap();
      } catch {
        // Offline or a hiccup: the next check tries again.
      } finally {
        busy = false;
      }
    };
    const timer = window.setInterval(() => void check(), checkEveryMs);
    window.addEventListener("focus", check);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", check);
    };
  }, [sync, reloadBootstrap, refreshStock, syncCustomerList]);

  useEffect(() => {
    versionsRef.current = data.versions;
  }, [data]);

  useEffect(() => {
    productsRef.current = products;
    // The first time the catalogue is ready, load stock once.
    if (status === "ready" && !stockLoaded.current) {
      stockLoaded.current = true;
      void refreshStock();
    }
  }, [products, status, refreshStock]);

  const refreshOutbox = useCallback(async () => {
    const store = outboxRef.current;
    if (store) setOutbox(await store.all());
  }, []);

  /** Sends what is waiting, oldest first. Stops at the first sign the connection is gone; what is left keeps its place. */
  const sendNow = useCallback(async () => {
    const store = outboxRef.current;
    if (!store || sending.current || !navigator.onLine) return;
    sending.current = true;
    try {
      const result = await sendQueuedSales(store, (item) => postSaleInvoice(item.request, item.idempotencyKey, { reference: item.offlineRef, soldAt: item.soldAt }));
      if (result.sent.length) {
        setLastSent({ count: result.sent.length, numbers: result.sent.map((entry) => entry.sale.invoice.number) });
        setStock((current) => {
          const next = new Map(current);
          for (const entry of result.sent) for (const level of entry.sale.stock) next.set(level.variantId, level.onHand);
          return next;
        });
      }
      setReachable(!result.stopped);
      await refreshOutbox();
    } finally {
      sending.current = false;
    }
  }, [refreshOutbox]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const store = await IndexedDbOutbox.open(outboxScope(data.business.id, data.user.id));
        if (!alive) return store.close();
        outboxRef.current = store;
        await refreshOutbox();
        void sendNow();
      } catch {
        // Without IndexedDB the till still sells online; it just cannot keep sales offline.
      }
    })();
    return () => {
      alive = false;
      outboxRef.current?.close();
      outboxRef.current = null;
    };
  }, [data.business.id, data.user.id, refreshOutbox, sendNow]);

  useEffect(() => {
    const online = () => { setBrowserOnline(true); setReachable(true); void sendNow(); };
    const offline = () => setBrowserOnline(false);
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => { window.removeEventListener("online", online); window.removeEventListener("offline", offline); };
  }, [sendNow]);

  const waiting = outbox.some((sale) => sale.status === "queued");
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => void sendNow(), resendEveryMs);
    return () => window.clearInterval(timer);
  }, [waiting, sendNow]);

  const offline = useMemo<PosContextValue["offline"]>(() => ({
    online: browserOnline && reachable,
    queued: outbox.filter((sale) => sale.status === "queued"),
    refused: outbox.filter((sale) => sale.status === "failed"),
    lastSent,
    nextReference: async () => {
      const store = outboxRef.current;
      if (!store) throw new Error("Sales cannot be kept on this device. Wait for the connection.");
      return offlineReference(data.terminal.name, await store.nextNumber(data.terminal.id));
    },
    save: async (sale) => {
      const store = outboxRef.current;
      if (!store) throw new Error("Sales cannot be kept on this device. Wait for the connection.");
      await store.add({ ...sale, status: "queued", attempts: 0, lastError: "", lastErrorCode: "" });
      await refreshOutbox();
    },
    markUnreachable: () => setReachable(false),
    sendNow,
    retry: async (seq) => {
      await outboxRef.current?.update(seq, { status: "queued" });
      await refreshOutbox();
      await sendNow();
    },
  }), [browserOnline, reachable, outbox, lastSent, data.terminal.id, data.terminal.name, refreshOutbox, sendNow]);

  const customers = useMemo(() => new CustomerIndex(customerList), [customerList]);
  const catalogue = useMemo(() => new CatalogueIndex(products, data), [products, data]);
  const permissions = data.user.permissions;
  const value = useMemo<PosContextValue>(() => ({
    offline,
    data,
    catalogue,
    customers,
    rememberCustomer: (customer) => setCustomerList((current) => [...current.filter((row) => row.id !== customer.id), customer]),
    catalogueStatus: status,
    catalogueError: error,
    shift,
    setShift,
    stockOnHand: stock,
    applyStock: (levels) => setStock((current) => {
      const next = new Map(current);
      for (const level of levels) next.set(level.variantId, level.onHand);
      return next;
    }),
    can: (permission) => permissions.includes("*") || permissions.includes(permission),
    syncNow: sync,
  }), [offline, data, catalogue, customers, status, error, shift, stock, permissions, sync]);

  return <PosContext.Provider value={value}>{children}</PosContext.Provider>;
}
