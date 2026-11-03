import { useQuery } from "@tanstack/react-query";
import { getAuditLog } from "../../api/auditApi";
import { ErrorMessage, PageTitle } from "../../app/FormElements";

export function AuditPage() {
  const auditQuery = useQuery({ queryKey: ["audit-log", 1], queryFn: () => getAuditLog() });
  const records = auditQuery.data?.data ?? [];
  return <div className="content">
    <PageTitle title="Audit history" description="Read-only business activity with actor, terminal, time and changes." />
    {auditQuery.isError && <ErrorMessage>{auditQuery.error.message}</ErrorMessage>}
    <section className="panel table-scroll"><table>
      <thead><tr><th>Time</th><th>Action</th><th>Entity</th><th>Record</th><th>User</th><th>Terminal</th><th>Changes</th></tr></thead>
      <tbody>{records.map((record) => <tr key={record.id}>
        <td>{new Date(record.createdAt).toLocaleString()}</td><td>{record.action}</td><td>{record.entity}</td>
        <td className="mono">{record.entityId}</td><td className="mono">{record.userId ?? "—"}</td><td className="mono">{record.terminalId ?? "—"}</td>
        <td><details><summary>View</summary><pre>{JSON.stringify({ before: record.before, after: record.after }, null, 2)}</pre></details></td>
      </tr>)}</tbody>
    </table>{!records.length && !auditQuery.isError && <p className="muted">{auditQuery.isPending ? "Loading audit history…" : "No audit entries yet."}</p>}</section>
  </div>;
}
