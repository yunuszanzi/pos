import { postJson, putJson, requestApi } from "./client";

export type AppUser = {
  id: string;
  email: string;
  displayName: string;
  roleId: string;
  active: boolean;
};

export type AppRole = { id: string; name: string; isSystem: boolean; permissionKeys?: string[] };
export type PermissionDefinition = { key: string; description: string };

export function getAllUsers(page = 1, pageSize = 25) {
  return requestApi<{ data: AppUser[]; page: number; pageSize: number }>(`/users?page=${page}&pageSize=${pageSize}`);
}

export function inviteUser(input: {
  email: string;
  displayName: string;
  roleId: string;
  branchIds: string[];
  pin?: string;
}) {
  return postJson<AppUser>("/users", input);
}

export function updateUser(id: string, input: Partial<{
  displayName: string;
  roleId: string;
  branchIds: string[];
  active: boolean;
  pin: string;
}>) {
  return putJson<AppUser>(`/users/${id}`, input);
}

export function generateUserPasswordResetLink(id: string) {
  return postJson<{ recoveryLink: string }>(`/users/${id}/password-reset`, {});
}

export function getAllRoles() {
  return requestApi<AppRole[]>("/roles");
}

export function createRole(input: { name: string; permissionKeys: string[] }) {
  return postJson<AppRole>("/roles", input);
}

export function updateRole(id: string, input: { name: string; permissionKeys: string[] }) {
  return putJson<AppRole>(`/roles/${id}`, input);
}

export function getAllPermissions() {
  return requestApi<PermissionDefinition[]>("/permissions");
}
