import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getAllBranches } from "../../api/orgApi";
import { generateUserPasswordResetLink, getAllRoles, getAllUsers, inviteUser, updateUser, type AppRole, type AppUser } from "../../api/usersApi";
import { ErrorMessage, Field, PageTitle, SelectInput, SuccessMessage, TextInput } from "../../app/FormElements";

export function UsersPage() {
  const queryClient = useQueryClient();
  const usersQuery = useQuery({
    queryKey: ["users-workspace"],
    queryFn: async () => Promise.all([getAllUsers(), getAllRoles(), getAllBranches()]),
  });
  const users: AppUser[] = usersQuery.data?.[0].data ?? [];
  const roles: AppRole[] = usersQuery.data?.[1] ?? [];
  const branches = usersQuery.data?.[2] ?? [];
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [recoveryLink, setRecoveryLink] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSuccess("");
    setBusy(true);
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      const branchId = String(form.get("branchId"));
      await inviteUser({
        email: String(form.get("email")),
        displayName: String(form.get("displayName")),
        roleId: String(form.get("roleId")),
        branchIds: [branchId],
        pin: String(form.get("pin") ?? "") || undefined,
      });
      setSuccess("Invitation sent. The user can set their password from the email.");
      formElement.reset();
      await queryClient.invalidateQueries({ queryKey: ["users-workspace"] });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not invite user");
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(user: AppUser) {
    setError("");
    try {
      await updateUser(user.id, { active: !user.active });
      await queryClient.invalidateQueries({ queryKey: ["users-workspace"] });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update user");
    }
  }

  async function resetPassword(user: AppUser) {
    setError("");
    setSuccess("");
    setRecoveryLink("");
    try {
      const result = await generateUserPasswordResetLink(user.id);
      setRecoveryLink(result.recoveryLink);
      setSuccess(`Recovery link generated for ${user.email}. Share it with the user securely.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not generate recovery link");
    }
  }

  return <div className="content">
    <PageTitle title="Users" description="Invite staff, assign roles and deactivate accounts without deleting history." />
    {usersQuery.isError && <ErrorMessage>{usersQuery.error.message}</ErrorMessage>}
    {error && <ErrorMessage>{error}</ErrorMessage>}
    {success && <SuccessMessage>{success}</SuccessMessage>}
    {recoveryLink && <section className="panel recovery-link"><strong>One-time recovery link</strong><a href={recoveryLink} rel="noreferrer" target="_blank">{recoveryLink}</a></section>}
    <div className="two-column">
      <section className="panel">
        <h2>Invite user</h2>
        <form className="stack" onSubmit={submit}>
          <Field label="Full name"><TextInput name="displayName" required /></Field>
          <Field label="Email"><TextInput name="email" type="email" required /></Field>
          <Field label="Role"><SelectInput name="roleId" required defaultValue=""><option value="" disabled>Select role</option>{roles.filter((role) => role.name !== "Owner").map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</SelectInput></Field>
          <Field label="Branch"><SelectInput name="branchId" required defaultValue=""><option value="" disabled>Select branch</option>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</SelectInput></Field>
          <Field label="Terminal PIN (optional)"><TextInput name="pin" inputMode="numeric" pattern="[0-9]{4,6}" minLength={4} maxLength={6} /></Field>
          <button className="button primary" disabled={busy || !roles.length || !branches.length}>{busy ? "Sending…" : "Send invite"}</button>
        </form>
      </section>
      <section className="panel">
        <h2>Staff accounts</h2>
        {usersQuery.isPending ? <p className="muted">Loading users…</p> : !users.length ? <p className="muted">No staff accounts found.</p> : <div className="table-scroll"><table>
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th /></tr></thead>
          <tbody>{users.map((user) => <tr key={user.id}>
            <td>{user.displayName}</td><td>{user.email}</td><td>{roles.find((role) => role.id === user.roleId)?.name ?? "—"}</td>
            <td><span className={user.active ? "status active" : "status"}>{user.active ? "Active" : "Inactive"}</span></td>
            <td className="action-cell">
              <button className="text-button" onClick={() => void resetPassword(user)}>Reset password</button>
              <button className="text-button" onClick={() => void toggleActive(user)}>{user.active ? "Deactivate" : "Reactivate"}</button>
            </td>
          </tr>)}</tbody>
        </table></div>}
      </section>
    </div>
  </div>;
}
