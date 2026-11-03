import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createRole, getAllPermissions, getAllRoles, type AppRole, type PermissionDefinition } from "../../api/usersApi";
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
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

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
      await createRole({ name: String(form.get("name")), permissionKeys: selected });
      setSelected([]);
      setSuccess("Role created.");
      formElement.reset();
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
        </li>)}</ul>}
      </section>
      <section className="panel">
        <h2>Create custom role</h2>
        <form className="stack" onSubmit={submit}>
          <Field label="Role name"><TextInput name="name" required maxLength={80} /></Field>
          <fieldset className="permission-list"><legend>Permissions</legend>
            {permissions.map((permission) => <label className="checkbox-row" key={permission.key}>
              <input checked={selected.includes(permission.key)} onChange={() => togglePermission(permission.key)} type="checkbox" />
              <span><strong>{permission.key}</strong><small>{permission.description}</small></span>
            </label>)}
          </fieldset>
          <button className="button primary">Create role</button>
        </form>
      </section>
    </div>
  </div>;
}
