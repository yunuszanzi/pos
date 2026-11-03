import { useAuth } from "./useAuth";

/** Mirrors the server check. Only used to hide controls; the API enforces every permission itself. */
export function hasPermission(permissions: string[], permission: string): boolean {
  return permissions.includes("*") || permissions.includes(permission);
}

export function useCan(permission: string): boolean {
  const { currentUser } = useAuth();
  return hasPermission(currentUser?.permissions ?? [], permission);
}
