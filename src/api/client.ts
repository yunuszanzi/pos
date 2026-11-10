import { supabase } from "./supabase";

type ApiError = {
  error?: { code?: string; message?: string; details?: unknown };
};

/** An error answered by the API, keeping the machine-readable code and any per-field details. */
export class ApiRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly details?: unknown) {
    super(message);
  }
}

/** The request never got an answer: no connection, or the server could not be reached at all. Whether it arrived is not known. */
export class NetworkError extends Error {
  constructor(message = "There is no connection to the server") {
    super(message);
  }
}

export async function requestApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("Please sign in again");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${session.access_token}`);
  // A file upload sets its own boundary; every other request is JSON.
  if (!(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const terminalId = localStorage.getItem("pos.terminalId");
  const pinSession = sessionStorage.getItem("pos.pinSession");
  if (terminalId) headers.set("X-Terminal-Id", terminalId);
  if (pinSession) headers.set("X-PIN-Session", pinSession);
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, { ...init, headers });
  } catch (caught) {
    // An aborted request is the caller's own doing (a stale search); anything else is the network.
    if (caught instanceof DOMException && caught.name === "AbortError") throw caught;
    throw new NetworkError();
  }
  // A dead or restarting API answers with an empty or non-JSON body (the dev proxy returns an empty 500); say what is wrong instead of a parser error.
  const result = await response.json().catch(() => null) as (T & ApiError) | null;
  if (result === null) {
    throw new ApiRequestError(response.ok ? "The server sent an unreadable answer. Try again." : "The server could not be reached. If you are running it yourself, start the API (npm run dev:api) and try again.", response.status);
  }
  if (!response.ok) {
    if (response.status === 401 && result.error?.code === "SESSION_INACTIVE") {
      sessionStorage.removeItem("pos.pinSession");
      await supabase.auth.signOut({ scope: "local" });
    }
    // A rejected PIN session would otherwise be resent forever; fall back to the signed-in account.
    if (result.error?.code === "INVALID_TERMINAL_SESSION") sessionStorage.removeItem("pos.pinSession");
    throw new ApiRequestError(result.error?.message ?? `Request failed (${response.status})`, response.status, result.error?.code, result.error?.details);
  }
  return result;
}

export function postJson<T>(path: string, body: unknown, headers?: Record<string, string>): Promise<T> {
  return requestApi<T>(path, { method: "POST", body: JSON.stringify(body), headers });
}

export function deleteJson<T>(path: string): Promise<T> {
  return requestApi<T>(path, { method: "DELETE" });
}

export function putJson<T>(path: string, body: unknown): Promise<T> {
  return requestApi<T>(path, { method: "PUT", body: JSON.stringify(body) });
}

/** Downloads a file from the API with the signed-in user's credentials and saves it through the browser. */
export async function downloadApiFile(path: string, fallbackName: string): Promise<void> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("Please sign in again");
  const headers = new Headers({ Authorization: `Bearer ${session.access_token}` });
  const terminalId = localStorage.getItem("pos.terminalId");
  const pinSession = sessionStorage.getItem("pos.pinSession");
  if (terminalId) headers.set("X-Terminal-Id", terminalId);
  if (pinSession) headers.set("X-PIN-Session", pinSession);
  const response = await fetch(`/api/v1${path}`, { headers });
  if (!response.ok) {
    const failure = await response.json().catch(() => ({})) as ApiError;
    throw new Error(failure.error?.message ?? `Download failed (${response.status})`);
  }
  const name = /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") ?? "")?.[1] ?? fallbackName;
  saveBlob(await response.blob(), name);
}

/** Saves text generated in the browser (for example the import template). */
export function saveTextFile(text: string, name: string, type = "text/csv;charset=utf-8"): void {
  saveBlob(new Blob(["\uFEFF", text], { type }), name);
}

function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
