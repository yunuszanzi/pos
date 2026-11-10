import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createRole, getAllPermissions, getAllRoles, updateRole, type AppRole, type PermissionDefinition } from "../../api/usersApi";
import { ErrorMessage, Field, PageTitle, SuccessMessage, TextInput } from "../../app/FormElements";

export function RolesPage() {
  const queryClient = useQueryClient();
  const rolesQuery = useQuery({
    queryKey: ["roles-workspace"],
    queryFn: async () => Promise.all([getAllRoles(), getAllPermissions()]),
  });
  const roles: AppRole[] = rolesQuery.data?.[0] ?? [];
  const permissions: PermissionDefinition[] = rolesQuery.data?.[1].filter((item) => item.key !== "*") ?? [];
  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState<AppRole | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  function startEditing(role: AppRole) {
    setEditing(role);
    setSelected(role.permissionKeys ?? []);
    setError("");
    setSuccess("");
  }

  function stopEditing(form?: HTMLFormElement) {
    setEditing(null);
    setSelected([]);
    form?.reset();
  }

  function togglePermission(key: string) {
    setSelected((current) => current.includes(key) ? current.filter((value) => value !== key) : [...current, key]);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSuccess("");
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      const input = { name: String(form.get("name")), permissionKeys: selected };
      if (editing) await updateRole(editing.id, input);
      else await createRole(input);
      setSuccess(editing ? "Role updated." : "Role created.");
      stopEditing(formElement);
      await queryClient.invalidateQueries({ queryKey: ["roles-workspace"] });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create role");
    }
  }

  return <div className="content">
    <PageTitle title="Roles & permissions" description="Use a least-privilege permission matrix. Owner access remains protected." />
    {error && <ErrorMessage>{error}</ErrorMessage>}
    {rolesQuery.isError && <ErrorMessage>{rolesQuery.error.message}</ErrorMessage>}
    {success && <SuccessMessage>{success}</SuccessMessage>}
    <div className="two-column">
      <section className="panel">
        <h2>Existing roles</h2>
        {rolesQuery.isPending ? <p className="muted">Loading roles…</p> : <ul className="role-list">{roles.map((role) => <li key={role.id}>
          <span><strong>{role.name}</strong><small>{role.permissionKeys?.length ?? 0} assigned permissions</small></span>
          <span className="status">{role.isSystem ? "System" : "Custom"}</span>
          {!role.isSystem && <button className="text-button" type="button" onClick={() => startEditing(role)}>Edit {role.name}</button>}
        </li>)}</ul>}
      </section>
      <section className="panel">
        <h2>{editing ? `Edit ${editing.name}` : "Create custom role"}</h2>
        <form className="stack" key={editing?.id ?? "new"} onSubmit={submit}>
          <Field label="Role name"><TextInput name="name" required maxLength={80} defaultValue={editing?.name ?? ""} /></Field>
          <fieldset className="permission-list"><legend>Permissions</legend>
            {permissions.map((permission) => <label className="checkbox-row" key={permission.key}>
              <input checked={selected.includes(permission.key)} onChange={() => togglePermission(permission.key)} type="checkbox" />
              <span><strong>{permission.key}</strong><small>{permission.description}</small></span>
            </label>)}
          </fieldset>
          <div className="button-row">
            <button className="button primary">{editing ? "Save role" : "Create role"}</button>
            {editing && <button className="button secondary" type="button" onClick={() => stopEditing()}>Cancel</button>}
          </div>
        </form>
      </section>
    </div>
  </div>;
}
