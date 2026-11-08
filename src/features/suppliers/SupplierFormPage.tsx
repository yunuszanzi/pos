import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { useNavigate, useParams } from "react-router-dom";
import { supplierSchema } from "../../../shared/schemas/suppliers";
import { createSupplier, getSupplierById, updateSupplier, type Supplier } from "../../api/suppliersApi";
import { ErrorMessage, Field, PageTitle, TextInput } from "../../app/FormElements";
import { QuantityInput } from "../../app/QuantityInput";

type Values = {
  name: string; contactPerson: string; phone: string; whatsapp: string; email: string; address: string;
  ntn: string; strn: string; registered: boolean; termsDays: string; notes: string;
};

const empty: Values = { name: "", contactPerson: "", phone: "", whatsapp: "", email: "", address: "", ntn: "", strn: "", registered: false, termsDays: "0", notes: "" };

const valuesOf = (supplier: Supplier): Values => ({
  name: supplier.name, contactPerson: supplier.contactPerson, phone: supplier.phone, whatsapp: supplier.whatsapp, email: supplier.email, address: supplier.address,
  ntn: supplier.ntn ?? "", strn: supplier.strn ?? "", registered: supplier.registered, termsDays: String(supplier.termsDays), notes: supplier.notes,
});

export function SupplierFormPage() {
  const { id } = useParams();
  const existing = useQuery({ queryKey: ["supplier", id], queryFn: () => getSupplierById(id!), enabled: Boolean(id), staleTime: 0 });
  if (id && existing.isPending) return <div className="content"><p className="muted">Loading…</p></div>;
  if (id && existing.isError) return <div className="content"><ErrorMessage>{existing.error.message}</ErrorMessage></div>;
  return <SupplierForm supplier={existing.data} />;
}

function SupplierForm({ supplier }: { supplier?: Supplier }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const { register, handleSubmit, setError: setFieldError, formState: { errors } } = useForm<Values>({ defaultValues: supplier ? valuesOf(supplier) : empty });

  async function save(values: Values) {
    setError("");
    const parsed = supplierSchema.safeParse({ ...values, termsDays: Number(values.termsDays || 0) });
    if (!parsed.success) {
      const [first] = parsed.error.issues;
      return setFieldError(String(first.path[0] ?? "name") as keyof Values, { message: first.message });
    }
    setBusy(true);
    try {
      if (supplier) await updateSupplier(supplier.id, { ...parsed.data, active: supplier.active });
      else await createSupplier(parsed.data);
      await queryClient.invalidateQueries({ queryKey: ["suppliers"] });
      navigate("/suppliers");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the supplier");
      setBusy(false);
    }
  }

  const problem = (name: keyof Values) => errors[name]?.message && <ErrorMessage>{errors[name]!.message}</ErrorMessage>;
  return <div className="content">
    <PageTitle title={supplier ? `Edit ${supplier.name}` : "New supplier"} description="Only the name is required. Payment terms are the days you have to pay a bill; 0 means on receipt." />
    <form className="panel stack" onSubmit={handleSubmit(save)} noValidate>
      <div className="form-grid">
        <Field label="Name"><TextInput {...register("name")} maxLength={200} autoFocus />{problem("name")}</Field>
        <Field label="Contact person"><TextInput {...register("contactPerson")} maxLength={200} /></Field>
        <Field label="Phone"><TextInput {...register("phone")} inputMode="tel" maxLength={20} />{problem("phone")}</Field>
        <Field label="WhatsApp"><TextInput {...register("whatsapp")} inputMode="tel" maxLength={20} />{problem("whatsapp")}</Field>
        <Field label="Email"><TextInput {...register("email")} type="email" maxLength={200} />{problem("email")}</Field>
        <Field label="Address"><TextInput {...register("address")} maxLength={500} /></Field>
        <Field label="NTN"><TextInput {...register("ntn")} maxLength={20} />{problem("ntn")}</Field>
        <Field label="STRN"><TextInput {...register("strn")} maxLength={20} />{problem("strn")}</Field>
        <label className="checkbox-row"><input type="checkbox" {...register("registered")} /><span>Registered for sales tax</span></label>
        <Field label="Payment terms (days)"><QuantityInput decimals={0} {...register("termsDays")} maxLength={3} />{problem("termsDays")}</Field>
        <Field label="Notes"><TextInput {...register("notes")} maxLength={1000} /></Field>
      </div>
      {error && <ErrorMessage>{error}</ErrorMessage>}
      <div className="button-row">
        <button className="button primary" disabled={busy}>{busy ? "Saving…" : "Save supplier"}</button>
        <button type="button" className="button secondary" onClick={() => navigate("/suppliers")}>Cancel</button>
      </div>
    </form>
  </div>;
}
