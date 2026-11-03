export const permissionDefinitions = [
  ["*", "All current and future permissions"],
  ["business.view", "View business profile"],
  ["business.update", "Update business profile"],
  ["branches.view", "View branches"],
  ["branches.manage", "Create, update and deactivate branches"],
  ["locations.view", "View stock locations"],
  ["locations.manage", "Create, update and deactivate locations"],
  ["terminals.view", "View terminals"],
  ["terminals.manage", "Create, update and deactivate terminals"],
  ["document_series.view", "View document numbering series"],
  ["document_series.manage", "Manage document numbering series"],
  ["users.view", "View users"],
  ["users.manage", "Invite, update and deactivate users"],
  ["roles.view", "View roles and permission assignments"],
  ["roles.manage", "Manage roles and permission assignments"],
  ["settings.view", "View business settings"],
  ["settings.manage", "Update business settings"],
  ["audit.view", "View audit history"],
  ["auth.pin_switch", "Switch the active terminal user with a PIN"],
  ["auth.manager_override", "Approve a manager-PIN override"],
] as const;

export type PermissionKey = (typeof permissionDefinitions)[number][0];
