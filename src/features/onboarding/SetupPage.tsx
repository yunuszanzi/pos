import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useNavigate } from "react-router-dom";
import type { z } from "zod";
import { createBusinessSetup } from "../../api/orgApi";
import { recordUserLogin } from "../../api/authApi";
import { useAuth } from "../../app/useAuth";
import { ErrorMessage, Field, PageTitle, TextInput } from "../../app/FormElements";
import { setupBusinessSchema } from "../../../shared/schemas/org";

export function SetupPage() {
  const { refreshCurrentUser, signOut } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const form = useForm<z.input<typeof setupBusinessSchema>, unknown, z.output<typeof setupBusinessSchema>>({
    resolver: zodResolver(setupBusinessSchema),
    defaultValues: {
      legalName: "",
      tradeName: "",
      phone: "",
      address: "",
      ntn: null,
      strn: null,
      province: "",
      logoUrl: null,
      receiptFooter: "",
      branchName: "Main Branch",
      branchCode: "KHI",
      locationName: "Main Store",
      terminalName: "Register 1",
      documentPrefix: "INV-KHI",
      ownerPin: "",
    },
  });

  async function submit(values: z.output<typeof setupBusinessSchema>) {
    setError("");
    setBusy(true);
    try {
      await createBusinessSetup(values);
      await recordUserLogin();
      await refreshCurrentUser();
      navigate("/");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Business setup failed");
    } finally {
      setBusy(false);
    }
  }

  return <main className="content narrow">
    <PageTitle title="Set up your business" description="Create the first branch, stock location, terminal and invoice series." />
    <form className="panel stack" onSubmit={form.handleSubmit(submit)}>
      <h2>Business profile</h2>
      <div className="form-grid">
        <Field label="Legal name"><TextInput {...form.register("legalName")} required /></Field>
        <Field label="Trade name"><TextInput {...form.register("tradeName")} required /></Field>
        <Field label="Phone"><TextInput {...form.register("phone")} type="tel" /></Field>
        <Field label="Province"><TextInput {...form.register("province")} /></Field>
        <Field label="NTN"><TextInput {...form.register("ntn")} /></Field>
        <Field label="STRN"><TextInput {...form.register("strn")} /></Field>
        <Field label="Logo URL (optional)"><TextInput {...form.register("logoUrl")} type="url" /></Field>
        <Field label="Address"><TextInput {...form.register("address")} /></Field>
        <Field label="Receipt footer"><TextInput {...form.register("receiptFooter")} /></Field>
      </div>
      <h2>First branch</h2>
      <div className="form-grid">
        <Field label="Branch name"><TextInput {...form.register("branchName")} required /></Field>
        <Field label="Branch code"><TextInput {...form.register("branchCode")} required /></Field>
        <Field label="Default stock location"><TextInput {...form.register("locationName")} required /></Field>
        <Field label="Terminal name"><TextInput {...form.register("terminalName")} required /></Field>
        <Field label="Invoice prefix"><TextInput {...form.register("documentPrefix")} required /></Field>
      </div>
      <h2>Owner terminal PIN</h2>
      <Field label="4–6 digit PIN"><TextInput {...form.register("ownerPin")} inputMode="numeric" pattern="[0-9]{4,6}" minLength={4} maxLength={6} required /></Field>
      {Object.values(form.formState.errors)[0]?.message && <ErrorMessage>{String(Object.values(form.formState.errors)[0]?.message)}</ErrorMessage>}
      {error && <ErrorMessage>{error}</ErrorMessage>}
      <div className="button-row">
        <button className="button primary" disabled={busy}>{busy ? "Creating…" : "Create business"}</button>
        <button className="button secondary" type="button" onClick={() => void signOut()}>Sign out</button>
      </div>
    </form>
  </main>;
}
