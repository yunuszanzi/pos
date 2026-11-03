import type { AuthError, Session } from "@supabase/supabase-js";
import { postJson } from "./client";
import { supabase } from "./supabase";
import { queryClient } from "../app/queryClient";

export type AuthResult = { session: Session | null; error: AuthError | null };

export async function signInWithPassword(email: string, password: string): Promise<AuthResult> {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  return { session: data.session, error };
}

export async function signUpOwner(email: string, password: string): Promise<AuthResult> {
  const { data, error } = await supabase.auth.signUp({ email, password });
  return { session: data.session, error };
}

export async function signOutUser(): Promise<void> {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
  sessionStorage.removeItem("pos.pinSession");
  localStorage.removeItem("pos.terminalId");
}

export async function requestPasswordReset(email: string): Promise<void> {
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/login`,
  });
  if (error) throw error;
}

export function recordUserLogin(): Promise<{ recorded: boolean }> {
  return postJson("/auth/login-event", {});
}

export async function switchTerminalUser(input: {
  targetEmail: string;
  pin: string;
  terminalId: string;
}): Promise<{ pinSession: string; activeUser: { id: string; email: string; displayName: string } }> {
  const result = await postJson<{ pinSession: string; activeUser: { id: string; email: string; displayName: string } }>("/auth/pin-switch", input);
  queryClient.clear();
  sessionStorage.setItem("pos.pinSession", result.pinSession);
  return result;
}
