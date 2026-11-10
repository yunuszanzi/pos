import type { ImportIssue } from "../../api/productsApi";

const visibleIssueLimit = 200;

/** Every problem found in an uploaded file, by row and column, so the user can fix it and choose the file again. */
export function IssuesTable({ issues }: { issues: ImportIssue[] }) {
  if (!issues.length) return null;
  return <section className="panel">
    <h2>Problems</h2>
    <div className="table-scroll"><table>
      <thead><tr><th>Row</th><th>Column</th><th>Problem</th></tr></thead>
      <tbody>{issues.slice(0, visibleIssueLimit).map((issue, index) => <tr key={`${issue.row}-${issue.field}-${index}`}>
        <td>{issue.row}</td><td className="mono">{issue.field}</td><td>{issue.message}</td>
      </tr>)}</tbody>
    </table></div>
    {issues.length > visibleIssueLimit && <p className="muted">Showing the first {visibleIssueLimit} of {issues.length} problems.</p>}
  </section>;
}
