import { useState, type FormEvent, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createBranch, createDocumentSeries, createLocation, createTerminal, getAllBranches, getAllDocumentSeries, getAllLocations, getAllTerminals, getBusinessProfile, updateBusinessProfile, type BusinessProfile } from "../../api/orgApi";
import { ErrorMessage, Field, PageTitle, SelectInput, SuccessMessage, TextInput } from "../../app/FormElements";

type Branch = { id: string; name: string; code: string; active: boolean };
type Location = { id: string; branchId: string; name: string; type: string; active: boolean };
type Terminal = { id: string; branchId: string; name: string; defaultPrintFormat: string; active: boolean };
type Series = { id: string; branchId: string; docType: string; prefix: string; nextNumber: number };
export function OrganizationPage() {
  const queryClient = useQueryClient();
  const organizationQuery = useQuery({
    queryKey: ["organization-workspace"],
    queryFn: async () => {
      const [business, branches, locations, terminals, series] = await Promise.all([
        getBusinessProfile(), getAllBranches(), getAllLocations(), getAllTerminals(), getAllDocumentSeries(),
      ]);
      return { business, branches, locations, terminals, series };
    },
  });
  const business: BusinessProfile | undefined = organizationQuery.data?.business;
  const branches: Branch[] = organizationQuery.data?.branches ?? [];
  const locations: Location[] = organizationQuery.data?.locations ?? [];
  const terminals: Terminal[] = organizationQuery.data?.terminals ?? [];
  const series: Series[] = organizationQuery.data?.series ?? [];
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      await updateBusinessProfile({
        legalName: String(data.legalName),
        tradeName: String(data.tradeName),
        phone: String(data.phone),
        address: String(data.address),
        ntn: String(data.ntn) || null,
        strn: String(data.strn) || null,
        province: String(data.province),
        logoUrl: String(data.logoUrl) || null,
        receiptFooter: String(data.receiptFooter),
      });
      setSuccess("Business profile saved.");
      await queryClient.invalidateQueries({ queryKey: ["organization-workspace"] });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save business profile");
    }
  }

  async function saveResource(event: FormEvent<HTMLFormElement>, kind: "branch" | "location" | "terminal" | "series") {
    event.preventDefault();
    setError("");
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    try {
      if (kind === "branch") await createBranch({ name: String(data.name), code: String(data.code) });
      if (kind === "location") await createLocation({ branchId: String(data.branchId), name: String(data.name), type: String(data.type) as "store" | "warehouse" | "damaged" });
      if (kind === "terminal") await createTerminal({ branchId: String(data.branchId), name: String(data.name), defaultPrintFormat: String(data.format) as "pos80" | "pos58" | "a4" | "a5" });
      if (kind === "series") await createDocumentSeries({ branchId: String(data.branchId), docType: String(data.docType), prefix: String(data.prefix), nextNumber: Number(data.nextNumber) });
      setSuccess("Organisation record saved.");
      form.reset();
      await queryClient.invalidateQueries({ queryKey: ["organization-workspace"] });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save organisation record");
    }
  }

  const branchOptions = branches.filter((branch) => branch.active);
  return <div className="content">
    <PageTitle title="Business & organisation" description="Manage the business profile, branches, stock locations, terminals and document prefixes." />
    {organizationQuery.isError && <ErrorMessage>{organizationQuery.error.message}</ErrorMessage>}
    {error && <ErrorMessage>{error}</ErrorMessage>}
    {success && <SuccessMessage>{success}</SuccessMessage>}
    <section className="panel">
      <h2>Business profile</h2>
      {organizationQuery.isPending ? <p className="muted">Loading business profile…</p> : business && <form className="form-grid" onSubmit={saveProfile}>
        <Field label="Legal name"><TextInput name="legalName" defaultValue={business.legalName} required /></Field>
        <Field label="Trade name"><TextInput name="tradeName" defaultValue={business.tradeName} required /></Field>
        <Field label="Phone"><TextInput name="phone" defaultValue={business.phone} /></Field>
        <Field label="Province"><TextInput name="province" defaultValue={business.province} /></Field>
        <Field label="NTN"><TextInput name="ntn" defaultValue={business.ntn ?? ""} /></Field>
        <Field label="STRN"><TextInput name="strn" defaultValue={business.strn ?? ""} /></Field>
        <Field label="Logo URL"><TextInput name="logoUrl" type="url" defaultValue={business.logoUrl ?? ""} /></Field>
        <Field label="Address"><TextInput name="address" defaultValue={business.address} /></Field>
        <Field label="Receipt footer"><TextInput name="receiptFooter" defaultValue={business.receiptFooter} /></Field>
        <div className="form-actions"><button className="button primary">Save profile</button></div>
      </form>}
    </section>
    <div className="two-column resource-grid">
      <ResourceForm title="Branches" onSubmit={(event) => saveResource(event, "branch")} entries={branches.map((item) => `${item.name} (${item.code})`)} fields={<>
        <Field label="Name"><TextInput name="name" required /></Field><Field label="Code"><TextInput name="code" required /></Field>
      </>} />
      <ResourceForm title="Locations" onSubmit={(event) => saveResource(event, "location")} entries={locations.map((item) => `${item.name} · ${item.type}`)} fields={<>
        <Field label="Branch"><SelectInput name="branchId" required>{branchOptions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</SelectInput></Field>
        <Field label="Name"><TextInput name="name" required /></Field>
        <Field label="Type"><SelectInput name="type"><option value="store">Store</option><option value="warehouse">Warehouse</option><option value="damaged">Damaged</option></SelectInput></Field>
      </>} />
      <ResourceForm title="Terminals" onSubmit={(event) => saveResource(event, "terminal")} entries={terminals.map((item) => `${item.name} · ${item.defaultPrintFormat}`)} fields={<>
        <Field label="Branch"><SelectInput name="branchId" required>{branchOptions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</SelectInput></Field>
        <Field label="Name"><TextInput name="name" required /></Field>
        <Field label="Default print"><SelectInput name="format"><option value="pos80">POS 80 mm</option><option value="pos58">POS 58 mm</option><option value="a4">A4</option><option value="a5">A5</option></SelectInput></Field>
      </>} />
      <ResourceForm title="Document series" onSubmit={(event) => saveResource(event, "series")} entries={series.map((item) => `${item.docType}: ${item.prefix} (next ${item.nextNumber})`)} fields={<>
        <Field label="Branch"><SelectInput name="branchId" required>{branchOptions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</SelectInput></Field>
        <Field label="Document type"><TextInput name="docType" defaultValue="invoice" required /></Field>
        <Field label="Prefix"><TextInput name="prefix" required /></Field>
        <Field label="Next number"><TextInput name="nextNumber" type="number" min={1} defaultValue={1} required /></Field>
      </>} />
    </div>
  </div>;
}

function ResourceForm({ title, entries, fields, onSubmit }: {
  title: string;
  entries: string[];
  fields: ReactNode;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return <section className="panel">
    <h2>{title}</h2>
    {entries.length > 0 && <ul className="compact-list">{entries.map((entry) => <li key={entry}>{entry}</li>)}</ul>}
    <form className="stack compact-form" onSubmit={onSubmit}>
      {fields}
      <button className="button secondary">Add</button>
    </form>
  </section>;
}
