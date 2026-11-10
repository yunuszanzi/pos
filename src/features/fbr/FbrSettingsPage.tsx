import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { fbrReferenceLabels, fbrReferenceKinds } from "../../../shared/fbr";
import { parseRupees, toPlainRupees } from "../../../shared/money";
import {
  getFbrConfig, getFbrPaymentMethods, getFbrReadiness, getFbrTaxCategories, getFbrTerminals, removeFbrToken, runFbrScenario, saveFbrConfig, saveFbrPaymentMethod,
  saveFbrTaxCategory, saveFbrTerminal, saveFbrToken, syncFbrReference, testFbrConnection, verifyFbrBuyer, type FbrConfig,
} from "../../api/fbrApi";
import { ErrorMessage, Field, PageTitle, SelectInput, SuccessMessage, TextInput } from "../../app/FormElements";
import { MoneyInput } from "../../app/MoneyInput";
import { timeText } from "./FbrLogPage";

/** The owner's FBR page: connection, token, seller details, FBR's lists, what is mapped, and the sandbox test scenarios. */
export function FbrSettingsPage() {
  const queryClient = useQueryClient();
  const config = useQuery({ queryKey: ["fbr-config"], queryFn: getFbrConfig });
  const readiness = useQuery({ queryKey: ["fbr-readiness"], queryFn: getFbrReadiness });
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const refresh = () => Promise.all(["fbr-config", "fbr-readiness", "fbr-terminals", "fbr-payment-methods", "fbr-tax-categories"].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
  async function run(task: () => Promise<string | void>) {
    setError(""); setMessage("");
    try {
      const done = await task();
      if (done) setMessage(done);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work");
    }
  }

  const data = config.data;
  if (config.isError) return <div className="content"><ErrorMessage>{config.error.message}</ErrorMessage></div>;
  if (!data) return <div className="content"><p className="muted">Loading…</p></div>;
  return <div className="content narrow">
    <PageTitle title="FBR integration" description="Report every sale and return to FBR as it happens. Only the owner can change these settings." />
    {data.adapter === "mock" && <p className="notice error" role="status" data-testid="fbr-mock-banner">Test mode: a built-in stand-in is answering instead of FBR. Nothing here reaches the real FBR.</p>}
    {error && <ErrorMessage>{error}</ErrorMessage>}
    {message && <SuccessMessage>{message}</SuccessMessage>}
    <ConnectionForm data={data} run={run} />
    <TokenPanel data={data} run={run} />
    <ReadinessPanel problems={readiness.data?.sellerProblems ?? []} gaps={readiness.data?.gaps ?? []} />
    <ReferencePanel data={data} run={run} />
    <MappingPanels run={run} />
    <ScenarioPanel data={data} run={run} />
    <BuyerCheck />
    <p><Link className="text-button" to="/fbr/log">Open the FBR log</Link></p>
  </div>;
}

type Run = (task: () => Promise<string | void>) => Promise<void>;

function ConnectionForm({ data, run }: { data: FbrConfig; run: Run }) {
  const [form, setForm] = useState({
    enabled: data.enabled, environment: data.environment,
    sellerName: data.seller.name, sellerNtn: data.seller.ntn, sellerStrn: data.seller.strn, sellerProvince: data.seller.province, sellerAddress: data.seller.address,
    cancelWindowHours: data.cancelWindowHours, confirmUntested: false,
  });
  const [threshold, setThreshold] = useState(toPlainRupees(data.buyerIdThresholdPaisa));
  useEffect(() => { setThreshold(toPlainRupees(data.buyerIdThresholdPaisa)); }, [data.buyerIdThresholdPaisa]);
  const goingLive = form.environment === "production" && !data.allScenariosPassed;

  function submit(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      await saveFbrConfig({ ...form, mode: "di", buyerIdThresholdPaisa: parseRupees(threshold) });
      return "FBR settings saved";
    });
  }
  return <form className="panel stack" onSubmit={submit} aria-label="FBR connection">
    <h2>Connection</h2>
    <label className="checkbox-row"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} /><span><strong>Report sales to FBR</strong><small>Needs the token and the seller details below.</small></span></label>
    <Field label="Way of reporting"><SelectInput value="di" disabled><option value="di">Digital Invoicing (online, through PRAL)</option></SelectInput></Field>
    <Field label="Environment"><SelectInput value={form.environment} onChange={(event) => setForm({ ...form, environment: event.target.value as FbrConfig["environment"] })}>
      <option value="sandbox">Sandbox (practice, not counted by FBR)</option><option value="production">Production (real invoices)</option>
    </SelectInput></Field>
    {goingLive && <label className="checkbox-row"><input type="checkbox" checked={form.confirmUntested} onChange={(event) => setForm({ ...form, confirmUntested: event.target.checked })} /><span><strong>Go live without passing every sandbox scenario</strong><small>The sandbox scenarios below are not all passed. FBR may refuse invoices that were never tested.</small></span></label>}
    <h3>Seller</h3>
    {data.suggestedSeller.name && !form.sellerName && <p className="muted">Your business profile says: {data.suggestedSeller.name}.</p>}
    <div className="form-grid">
      <Field label="Business name"><TextInput value={form.sellerName} maxLength={200} onChange={(event) => setForm({ ...form, sellerName: event.target.value })} /></Field>
      <Field label="NTN"><TextInput value={form.sellerNtn} maxLength={20} onChange={(event) => setForm({ ...form, sellerNtn: event.target.value })} /></Field>
      <Field label="STRN"><TextInput value={form.sellerStrn} maxLength={30} onChange={(event) => setForm({ ...form, sellerStrn: event.target.value })} /></Field>
      <Field label="Province"><TextInput value={form.sellerProvince} maxLength={60} onChange={(event) => setForm({ ...form, sellerProvince: event.target.value })} /></Field>
      <Field label="Address"><TextInput value={form.sellerAddress} maxLength={300} onChange={(event) => setForm({ ...form, sellerAddress: event.target.value })} /></Field>
      <Field label="Keep trying for (hours)"><TextInput type="number" min={0} max={8760} value={form.cancelWindowHours} onChange={(event) => setForm({ ...form, cancelWindowHours: Number(event.target.value) })} /></Field>
      <Field label="Buyer's NTN or CNIC needed above (PKR)"><MoneyInput value={threshold} onChange={(event) => setThreshold(event.target.value)} /></Field>
    </div>
    <div className="button-row"><button className="button primary">Save FBR settings</button></div>
  </form>;
}

function TokenPanel({ data, run }: { data: FbrConfig; run: Run }) {
  const [token, setToken] = useState("");
  return <section className="panel stack" aria-label="FBR token">
    <h2>Security token</h2>
    <p data-testid="fbr-token-state">{data.token.set ? `A token is saved (ends …${data.token.hint}). It is stored encrypted and cannot be shown again.` : "No token saved yet."}</p>
    <Field label={data.token.set ? "Replace the token" : "FBR security token"}><TextInput type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} /></Field>
    <div className="button-row">
      <button className="button secondary" disabled={token.trim().length < 8} onClick={() => void run(async () => { await saveFbrToken(token.trim()); setToken(""); return "Token saved"; })}>Save token</button>
      {data.token.set && <button className="button secondary" onClick={() => void run(async () => { await removeFbrToken(); return "Token removed. FBR reporting is off."; })}>Remove token</button>}
      <button className="button secondary" disabled={!data.token.set} onClick={() => void run(async () => { const result = await testFbrConnection(); if (!result.ok) throw new Error(result.message); return `Connected: ${result.message}`; })}>Test connection</button>
    </div>
    {data.lastTest && <p className="muted" data-testid="fbr-last-test">Last test {timeText(data.lastTest.at)}: {data.lastTest.ok ? "worked" : "failed"}. {data.lastTest.message}</p>}
  </section>;
}

function ReadinessPanel({ problems, gaps }: { problems: string[]; gaps: Array<{ key: string; title: string; total: number; examples: string[]; blocksSales: boolean }> }) {
  const open = gaps.filter((gap) => gap.total > 0);
  return <section className="panel stack" aria-label="What is missing">
    <h2>What is still missing</h2>
    {problems.length === 0 && open.length === 0 && <p>Nothing. Every seller detail and product FBR needs is in place.</p>}
    <ul>{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>
    <ul>{open.map((gap) => <li key={gap.key}><strong>{gap.title}</strong>: {gap.total}{gap.examples.length > 0 && <small className="block muted">e.g. {gap.examples.join(", ")}</small>}{gap.blocksSales && <small className="block muted">Sales of these are held back from FBR until fixed.</small>}</li>)}</ul>
  </section>;
}

function ReferencePanel({ data, run }: { data: FbrConfig; run: Run }) {
  return <section className="panel stack" aria-label="FBR lists">
    <h2>FBR's lists</h2>
    <p className="muted">HS codes, units, provinces and sale types come from FBR. {data.lastSyncAt ? `Last updated ${timeText(data.lastSyncAt)}.` : "Not updated yet."}</p>
    <ul>{fbrReferenceKinds.map((kind) => <li key={kind}>{fbrReferenceLabels[kind]}: {data.referenceCounts[kind]}</li>)}</ul>
    <div className="button-row"><button className="button secondary" disabled={!data.token.set} onClick={() => void run(async () => {
      const { results } = await syncFbrReference();
      const failed = results.filter((result) => !result.ok);
      if (failed.length) throw new Error(failed.map((result) => `${fbrReferenceLabels[result.kind]}: ${result.message}`).join("; "));
      return "FBR's lists are up to date";
    })}>Update from FBR</button></div>
  </section>;
}

function MappingPanels({ run }: { run: Run }) {
  const terminals = useQuery({ queryKey: ["fbr-terminals"], queryFn: getFbrTerminals });
  const methods = useQuery({ queryKey: ["fbr-payment-methods"], queryFn: getFbrPaymentMethods });
  const categories = useQuery({ queryKey: ["fbr-tax-categories"], queryFn: getFbrTaxCategories });
  const [posIds, setPosIds] = useState<Record<string, string>>({});
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [sale, setSale] = useState<Record<string, { fbrSaleType: string; sroScheduleNo: string; sroItemSerialNo: string }>>({});
  return <>
    <section className="panel stack" aria-label="Registers">
      <h2>Registers</h2>
      <p className="muted">The FBR POS number of each register, for the future fiscal-device mode. Not needed for online invoicing.</p>
      {(terminals.data?.data ?? []).map((terminal) => <div className="form-grid" key={terminal.id}>
        <Field label={`${terminal.name} (${terminal.branchName})`}><TextInput value={posIds[terminal.id] ?? terminal.fbrPosId} onChange={(event) => setPosIds({ ...posIds, [terminal.id]: event.target.value })} /></Field>
        <button className="button secondary" onClick={() => void run(async () => { await saveFbrTerminal(terminal.id, { fbrPosId: posIds[terminal.id] ?? terminal.fbrPosId, fbrEnabled: terminal.fbrEnabled }); return `${terminal.name} saved`; })}>Save</button>
      </div>)}
    </section>
    <section className="panel stack" aria-label="Payment methods">
      <h2>Payment methods</h2>
      {(methods.data?.data ?? []).map((method) => <div className="form-grid" key={method.id}>
        <Field label={`${method.name} → FBR payment code`}><TextInput value={codes[method.id] ?? method.fbrPaymentCode} onChange={(event) => setCodes({ ...codes, [method.id]: event.target.value })} /></Field>
        <button className="button secondary" onClick={() => void run(async () => { await saveFbrPaymentMethod(method.id, codes[method.id] ?? method.fbrPaymentCode); return `${method.name} saved`; })}>Save</button>
      </div>)}
    </section>
    <section className="panel stack" aria-label="Tax categories">
      <h2>Tax categories</h2>
      {(categories.data?.data ?? []).map((category) => {
        const value = sale[category.id] ?? { fbrSaleType: category.fbrSaleType, sroScheduleNo: category.sroScheduleNo, sroItemSerialNo: category.sroItemSerialNo };
        const set = (patch: Partial<typeof value>) => setSale({ ...sale, [category.id]: { ...value, ...patch } });
        return <div className="form-grid" key={category.id}>
          <Field label={`${category.name} → FBR sale type`}><TextInput value={value.fbrSaleType} onChange={(event) => set({ fbrSaleType: event.target.value })} /></Field>
          <Field label="SRO schedule no."><TextInput value={value.sroScheduleNo} onChange={(event) => set({ sroScheduleNo: event.target.value })} /></Field>
          <Field label="SRO item no."><TextInput value={value.sroItemSerialNo} onChange={(event) => set({ sroItemSerialNo: event.target.value })} /></Field>
          <button className="button secondary" onClick={() => void run(async () => { await saveFbrTaxCategory(category.id, value); return `${category.name} saved`; })}>Save</button>
        </div>;
      })}
    </section>
  </>;
}

function ScenarioPanel({ data, run }: { data: FbrConfig; run: Run }) {
  return <section className="panel stack" aria-label="Sandbox scenarios">
    <h2>Sandbox test scenarios</h2>
    <p className="muted">FBR asks each business to pass its test scenarios in the sandbox before going live. Each run checks a made-up invoice; nothing is reported.</p>
    <table aria-label="Scenarios">
      <thead><tr><th>Scenario</th><th>Result</th><th /></tr></thead>
      <tbody>{data.scenarios.map((scenario) => <tr key={scenario.id}>
        <td><strong>{scenario.id}</strong> {scenario.title}</td>
        <td data-testid={`scenario-${scenario.id}`}>{scenario.passed === null ? "Not run" : scenario.passed ? "Passed" : `Failed: ${scenario.message}`}{scenario.ranAt && <small className="block muted">{timeText(scenario.ranAt)}</small>}</td>
        <td><button className="button secondary" disabled={!data.token.set || data.environment !== "sandbox"} onClick={() => void run(async () => { const result = await runFbrScenario(scenario.id); return `${scenario.id}: ${result.passed ? "passed" : "failed"}`; })}>Run</button></td>
      </tr>)}</tbody>
    </table>
  </section>;
}

function BuyerCheck() {
  const [no, setNo] = useState("");
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const check = useMutation({
    mutationFn: () => verifyFbrBuyer(no.trim()),
    onSuccess: (value) => { setError(""); setResult(value.message); },
    onError: (caught: Error) => { setResult(""); setError(caught.message); },
  });
  return <section className="panel stack" aria-label="Check a buyer">
    <h2>Check a buyer with FBR</h2>
    <Field label="Buyer's NTN or STRN"><TextInput value={no} maxLength={20} onChange={(event) => setNo(event.target.value)} /></Field>
    <div className="button-row"><button className="button secondary" disabled={no.trim().length < 7 || check.isPending} onClick={() => check.mutate()}>Check</button></div>
    {result && <p role="status" data-testid="buyer-result">{result}</p>}
    {error && <ErrorMessage>{error}</ErrorMessage>}
  </section>;
}
