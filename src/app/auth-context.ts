import { createContext } from "react";
import type { Session } from "@supabase/supabase-js";

export type CurrentUser = {
  authUserId: string;
  email: string | null;
  userId: string | null;
  activeUserId: string | null;
  activeUserName: string | null;
  activeUserEmail: string | null;
  businessId: string | null;
  roleId: string | null;
  terminalId: string | null;
  permissions: string[];
};

export type AuthContextValue = {
  session: Session | null;
  currentUser: CurrentUser | null;
  loading: boolean;
  authError: string;
  refreshCurrentUser: () => Promise<CurrentUser>;
  signOut: () => Promise<void>;
};

export const AuthContext = createContext<AuthContextValue | null>(null);
