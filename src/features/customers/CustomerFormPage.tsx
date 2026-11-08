import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { useNavigate, useParams } from "react-router-dom";
import { toPlainRupees } from "../../../shared/money";
import { customerSchema } from "../../../shared/schemas/customers";
import { createCustomer, getAllAreas, getAllCustomerGroups, getCustomerById, updateCustomer, type Customer } from "../../api/customersApi";
import { getAllPriceLists } from "../../api/catalogueApi";
import { ErrorMessage, Field, PageTitle, SelectInput, TextInput } from "../../app/FormElements";
import { MoneyInput } from "../../app/MoneyInput";
import { amountOf } from "../../pos/amounts";

type Values = {
  name: string; businessName: string; phone: string; phone2: string; whatsapp: string; email: string; address: string;
  areaId: string; groupId: string; priceListId: string; cnic: string; ntn: string; strn: string; registered: boolean;
  creditLimit: string; termsDays: string; notes: string;
};

const empty: Values = {
  name: "", businessName: "", phone: "", phone2: "", whatsapp: "", email: "", address: "", areaId: "", groupId: "", priceListId: "", cnic: "", ntn: "", strn: "",
  registered: false, creditLimit: "0.00", termsDays: "0", notes: "",
};

const valuesOf = (customer: Customer): Values => ({
  name: customer.name, businessName: customer.businessName, phone: customer.phone, phone2: customer.phone2, whatsapp: customer.whatsapp, email: customer.email,
  address: customer.address, areaId: customer.areaId ?? "", groupId: customer.groupId ?? "", priceListId: customer.priceListId ?? "", cnic: customer.cnic ?? "",
  ntn: customer.ntn ?? "", strn: customer.strn ?? "", registered: customer.registered, creditLimit: toPlainRupees(customer.creditLimitPaisa),
  termsDays: String(customer.termsDays), notes: customer.notes,
});

const staleTime = 5 * 60_000;

export function CustomerFormPage() {
  const { id } = useParams();
  const existing = useQuery({ queryKey: ["customer", id], queryFn: () => getCustomerById(id!), enabled: Boolean(id), staleTime: 0 });
  if (id && existing.isPending) return <div className="content"><p className="muted">Loading…</p></div>;
  if (id && existing.isError) return <div className="content"><ErrorMessage>{existing.error.message}</ErrorMessage></div>;
  return <CustomerForm customer={existing.data} />;
}

function CustomerForm({ customer }: { customer?: Customer }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const areas = useQuery({ queryKey: ["areas"], queryFn: getAllAreas, staleTime });
  const groups = useQuery({ queryKey: ["customer-groups"], queryFn: getAllCustomerGroups, staleTime });
  const priceLists = useQuery({ queryKey: ["price-lists"], queryFn: getAllPriceLists, staleTime });
  const { register, handleSubmit, setError: setFieldError, formState: { errors } } = useForm<Values>({ defaultValues: customer ? valuesOf(customer) : empty });

  async function save(values: Values) {
    setError("");
    const creditLimitPaisa = amountOf(values.creditLimit || "0");
    if (creditLimitPaisa === null) return setFieldError("creditLimit", { message: "Enter rupees such as 50000.00" });
    const parsed = customerSchema.safeParse({
      ...values, areaId: values.areaId || null, groupId: values.groupId || null, priceListId: values.priceListId || null,
      creditLimitPaisa, termsDays: Number(values.termsDays || 0), ntn: values.ntn, strn: values.strn,
    });
    if (!parsed.success) {
      const [first] = parsed.error.issues;
      const field = String(first.path[0] ?? "");
      return setFieldError((field === "creditLimitPaisa" ? "creditLimit" : field) as keyof Values, { message: first.message });
    }
    setBusy(true);
    try {
      if (customer) await updateCustomer(customer.id, { ...parsed.data, active: customer.active });
      else await createCustomer(parsed.data);
      await queryClient.invalidateQueries({ queryKey: ["customers"] });
      navigate("/customers");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the customer");
      setBusy(false);
    }
  }

  const problem = (name: keyof Values) => errors[name]?.message && <ErrorMessage>{errors[name]!.message}</ErrorMessage>;
  return <div className="content">
    <PageTitle title={customer ? `Edit ${customer.name}` : "New customer"} description="Only the name is required. Credit limit 0 means the customer pays in full." />
    <form className="panel stack" onSubmit={handleSubmit(save)} noValidate>
      <div className="form-grid">
        <Field label="Name"><TextInput {...register("name")} maxLength={200} autoFocus />{problem("name")}</Field>
        <Field label="Business name"><TextInput {...register("businessName")} maxLength={200} /></Field>
        <Field label="Phone"><TextInput {...register("phone")} inputMode="tel" maxLength={20} />{problem("phone")}</Field>
        <Field label="Second phone"><TextInput {...register("phone2")} inputMode="tel" maxLength={20} />{problem("phone2")}</Field>
        <Field label="WhatsApp"><TextInput {...register("whatsapp")} inputMode="tel" maxLength={20} />{problem("whatsapp")}</Field>
        <Field label="Email"><TextInput {...register("email")} type="email" maxLength={200} />{problem("email")}</Field>
        <Field label="Address"><TextInput {...register("address")} maxLength={500} /></Field>
        <Field label="Area"><SelectInput {...register("areaId")}><option value="">None</option>{(areas.data ?? []).filter((area) => area.active || area.id === customer?.areaId).map((area) => <option key={area.id} value={area.id}>{area.name}</option>)}</SelectInput></Field>
        <Field label="Group"><SelectInput {...register("groupId")}><option value="">None</option>{(groups.data ?? []).filter((group) => group.active || group.id === customer?.groupId).map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</SelectInput></Field>
        <Field label="Price list (tier)"><SelectInput {...register("priceListId")}><option value="">Group's list, else shelf prices</option>{(priceLists.data ?? []).filter((list) => list.active || list.id === customer?.priceListId).map((list) => <option key={list.id} value={list.id}>{list.name}</option>)}</SelectInput></Field>
        <Field label="CNIC"><TextInput {...register("cnic")} inputMode="numeric" placeholder="42101-1234567-1" maxLength={15} />{problem("cnic")}</Field>
        <Field label="NTN"><TextInput {...register("ntn")} maxLength={20} />{problem("ntn")}</Field>
        <Field label="STRN"><TextInput {...register("strn")} maxLength={20} />{problem("strn")}</Field>
        <label className="checkbox-row"><input type="checkbox" {...register("registered")} /><span>Registered for sales tax</span></label>
        <Field label="Credit limit (Rs)"><MoneyInput {...register("creditLimit")} />{problem("creditLimit")}</Field>
        <Field label="Payment terms (days)"><TextInput {...register("termsDays")} inputMode="numeric" maxLength={3} />{problem("termsDays")}</Field>
        <Field label="Notes"><TextInput {...register("notes")} maxLength={1000} /></Field>
      </div>
      {error && <ErrorMessage>{error}</ErrorMessage>}
      <div className="button-row">
        <button className="button primary" disabled={busy}>{busy ? "Saving…" : "Save customer"}</button>
        <button type="button" className="button secondary" onClick={() => navigate("/customers")}>Cancel</button>
      </div>
    </form>
  </div>;
}
