import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { getAppBootstrapData, getDataVersions, getProductChangesSince, type AppBootstrapData, type DataVersions } from "../api/posApi";
import type { Product } from "../api/productsApi";
import { useTerminalStore } from "../app/terminalStore";
import { PosCache, cacheScope } from "./catalogueCache";
import { CatalogueIndex } from "./catalogueIndex";
import { syncCatalogue, whatChanged } from "./catalogueSync";
import { rememberCacheScope } from "./localData";
import { PosContext, type PosContextValue } from "./pos-context";

const checkEveryMs = 5 * 60_000;

/** Loads what the till needs once (technical-plan 5.7): bootstrap data, then the catalogue from the local cache, then only what changed. */
export function PosProvider({ children }: { children: ReactNode }) {
  const terminalId = useTerminalStore((state) => state.terminalId);
  const bootstrap = useQuery({
    queryKey: ["pos-bootstrap", terminalId],
    queryFn: getAppBootstrapData,
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
  const [shift, setShift] = useState(data.shift);
  const [stock, setStock] = useState<ReadonlyMap<string, string>>(new Map());
  const cacheRef = useRef<PosCache | null>(null);
  const versionsRef = useRef<DataVersions>(data.versions);
  const syncing = useRef(false);

  const scope = cacheScope(data.business.id, data.user.id);

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
        setStatus("syncing");
        await sync();
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
  }, [scope, sync]);

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
        if (changed.some((dataset) => dataset !== "catalogue")) await reloadBootstrap();
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
  }, [sync, reloadBootstrap]);

  useEffect(() => {
    versionsRef.current = data.versions;
  }, [data]);

  const catalogue = useMemo(() => new CatalogueIndex(products, data), [products, data]);
  const permissions = data.user.permissions;
  const value = useMemo<PosContextValue>(() => ({
    data,
    catalogue,
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
  }), [data, catalogue, status, error, shift, stock, permissions, sync]);

  return <PosContext.Provider value={value}>{children}</PosContext.Provider>;
}
