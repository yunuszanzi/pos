import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { requestApi } from "../api/client";
import { signOutUser } from "../api/authApi";
import { supabase } from "../api/supabase";
import { AuthContext, type AuthContextValue, type CurrentUser } from "./auth-context";
import { queryClient } from "./queryClient";
import { wipeLocalPosData } from "../pos/localData";
import { useTerminalStore } from "./terminalStore";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState("");

  const refreshCurrentUser = useCallback(async () => {
    const user = await requestApi<CurrentUser>("/me");
    setCurrentUser(user);
    return user;
  }, []);

  useEffect(() => {
    let active = true;
    const load = async (nextSession: Session | null) => {
      setSession(nextSession);
      setAuthError("");
      if (!nextSession) {
        setCurrentUser(null);
        queryClient.clear();
        void wipeLocalPosData();
        useTerminalStore.getState().setTerminalId("");
        setLoading(false);
        return;
      }
      try {
        const user = await requestApi<CurrentUser>("/me");
        if (active) setCurrentUser(user);
      } catch (caught) {
        if (active) {
          setCurrentUser(null);
          setAuthError(caught instanceof Error ? caught.message : "Could not load user profile");
        }
      } finally {
        if (active) setLoading(false);
      }
    };
    void supabase.auth.getSession().then(({ data, error }) => {
      if (error) throw error;
      return load(data.session);
    }).catch((error: unknown) => {
      console.error("Could not load authentication session", error);
      if (active) setLoading(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      window.setTimeout(() => void load(nextSession), 0);
    });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  const value: AuthContextValue = {
    session,
    currentUser,
    loading,
    authError,
    refreshCurrentUser,
    signOut: async () => {
      await signOutUser();
      queryClient.clear();
      await wipeLocalPosData();
      useTerminalStore.getState().setTerminalId("");
      setCurrentUser(null);
      setSession(null);
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
