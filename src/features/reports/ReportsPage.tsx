import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { reportGroups } from "../../../shared/reports";
import { getReportCatalogue } from "../../api/reportsApi";
import { ErrorMessage, PageTitle } from "../../app/FormElements";
import { useCan } from "../../app/permissions";

/** Every report the person may run, by group. */
export function ReportsPage() {
  const catalogue = useQuery({ queryKey: ["report-catalogue"], queryFn: getReportCatalogue, staleTime: 60_000 });
  const maySales = useCan("reports.sales.view");
  const reports = catalogue.data?.data ?? [];

  return <div className="content">
    <PageTitle title="Reports" description="Choose a report, then narrow it by dates, branch, person, customer or product. Every report can be exported to a spreadsheet or printed." />
    {catalogue.isError && <ErrorMessage>{catalogue.error.message}</ErrorMessage>}
    {catalogue.isPending && <p className="muted">Loading…</p>}
    {catalogue.isSuccess && reports.length === 0 && <p className="muted">You do not have permission to see any report.</p>}
    {maySales && <p><Link className="text-button" to="/reports/daily-sales">Daily sales (one day, with the best sellers and how it was paid)</Link></p>}
    {reportGroups.map((group) => {
      const inGroup = reports.filter((report) => report.group === group);
      if (!inGroup.length) return null;
      return <section className="panel stack" key={group} aria-label={group}>
        <h2>{group}</h2>
        <ul className="role-list">
          {inGroup.map((report) => <li key={report.key}>
            <span><Link className="text-button" to={`/reports/${report.key}`}>{report.title}</Link><small>{report.description}</small></span>
          </li>)}
        </ul>
      </section>;
    })}
  </div>;
}
