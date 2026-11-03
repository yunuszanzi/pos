import { supabase } from "./supabase";

type ApiError = {
  error?: { code?: string; message?: string };
};

export async function requestApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("Please sign in again");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${session.access_token}`);
  headers.set("Content-Type", "application/json");
  const terminalId = localStorage.getItem("pos.terminalId");
  const pinSession = sessionStorage.getItem("pos.pinSession");
  if (terminalId) headers.set("X-Terminal-Id", terminalId);
  if (pinSession) headers.set("X-PIN-Session", pinSession);
  const response = await fetch(`/api/v1${path}`, { ...init, headers });
  const result = await response.json() as T & ApiError;
  if (!response.ok) {
    if (response.status === 401 && result.error?.code === "SESSION_INACTIVE") {
      sessionStorage.removeItem("pos.pinSession");
      await supabase.auth.signOut({ scope: "local" });
    }
    throw new Error(result.error?.message ?? `Request failed (${response.status})`);
  }
  return result;
}

export function postJson<T>(path: string, body: unknown): Promise<T> {
  return requestApi<T>(path, { method: "POST", body: JSON.stringify(body) });
}

export function putJson<T>(path: string, body: unknown): Promise<T> {
  return requestApi<T>(path, { method: "PUT", body: JSON.stringify(body) });
}
