import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { getAllPriceLists } from "../../api/catalogueApi";
import { createArea, createCustomerGroup, getAllAreas, getAllCustomerGroups, updateArea, updateCustomerGroup } from "../../api/customersApi";
import { ErrorMessage, Field, PageTitle, SelectInput, SuccessMessage, TextInput } from "../../app/FormElements";
import { useCan } from "../../app/permissions";

const staleTime = 5 * 60_000;

export function CustomerSetupPage() {
  const queryClient = useQueryClient();
  const canManage = useCan("customers.manage");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const areas = useQuery({ queryKey: ["areas"], queryFn: getAllAreas, staleTime });
  const groups = useQuery({ queryKey: ["customer-groups"], queryFn: getAllCustomerGroups, staleTime });
  const priceLists = useQuery({ queryKey: ["price-lists"], queryFn: getAllPriceLists, staleTime });
  const listName = new Map((priceLists.data ?? []).map((list) => [list.id, list.name]));

  async function run(key: string, work: () => Promise<unknown>, done: string) {
    setError("");
    setNotice("");
    try {
      await work();
      await queryClient.invalidateQueries({ queryKey: [key] });
      setNotice(done);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save");
    }
  }

  const submit = (handler: (form: FormData) => void) => (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const element = event.currentTarget;
    handler(new FormData(element));
    element.reset();
  };

  return <div className="content">
    <PageTitle title="Customer groups and areas" description="A group can carry a price list, so everyone in it buys at that tier. Areas help with routes and reports." />
    <p><Link className="text-button" to="/customers">← Back to customers</Link></p>
    {error && <ErrorMessage>{error}</ErrorMessage>}
    {notice && <SuccessMessage>{notice}</SuccessMessage>}
    <div className="two-column">
      <section className="panel stack" aria-label="Groups">
        <h2>Groups</h2>
        <ul className="role-list">{(groups.data ?? []).map((group) => <li key={group.id}>
          <span><strong>{group.name}</strong>{group.priceListId && <small className="block muted">Tier: {listName.get(group.priceListId) ?? "price list"}</small>}{!group.active && <span className="status">Archived</span>}</span>
          {canManage && <button className="text-button" type="button" onClick={() => void run("customer-groups", () => updateCustomerGroup(group.id, { name: group.name, priceListId: group.priceListId, active: !group.active }), group.active ? "Group archived." : "Group restored.")}>{group.active ? "Archive" : "Restore"}</button>}
        </li>)}</ul>
        {groups.data && !groups.data.length && <p className="muted">No groups yet.</p>}
        {canManage && <form className="stack" onSubmit={submit((form) => void run("customer-groups", () => createCustomerGroup({ name: String(form.get("name") ?? "").trim(), priceListId: String(form.get("priceListId") ?? "") || null }), "Group added."))}>
          <Field label="New group"><TextInput name="name" required maxLength={100} /></Field>
          <Field label="Price list (optional)"><SelectInput name="priceListId" defaultValue=""><option value="">Shelf prices</option>{(priceLists.data ?? []).filter((list) => list.active).map((list) => <option key={list.id} value={list.id}>{list.name}</option>)}</SelectInput></Field>
          <button className="button primary">Add group</button>
        </form>}
      </section>
      <section className="panel stack" aria-label="Areas">
        <h2>Areas</h2>
        <ul className="role-list">{(areas.data ?? []).map((area) => <li key={area.id}>
          <span><strong>{area.name}</strong>{!area.active && <span className="status">Archived</span>}</span>
          {canManage && <button className="text-button" type="button" onClick={() => void run("areas", () => updateArea(area.id, { name: area.name, active: !area.active }), area.active ? "Area archived." : "Area restored.")}>{area.active ? "Archive" : "Restore"}</button>}
        </li>)}</ul>
        {areas.data && !areas.data.length && <p className="muted">No areas yet.</p>}
        {canManage && <form className="stack" onSubmit={submit((form) => void run("areas", () => createArea({ name: String(form.get("name") ?? "").trim() }), "Area added."))}>
          <Field label="New area"><TextInput name="name" required maxLength={100} /></Field>
          <button className="button primary">Add area</button>
        </form>}
      </section>
    </div>
  </div>;
}
