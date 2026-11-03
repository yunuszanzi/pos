import { useEffect, useState, type FormEvent } from "react";
import { parseRupees, toPlainRupees } from "../../../shared/money";
import { getBusinessSettings, updateBusinessSettings, type BusinessSettings } from "../../api/settingsApi";
import { ErrorMessage, Field, PageTitle, SelectInput, SuccessMessage, TextInput } from "../../app/FormElements";
import { MoneyInput } from "../../app/MoneyInput";

const defaults: BusinessSettings = {
  currency: "PKR",
  timezone: "Asia/Karachi",
  dateFormat: "dd/MM/yyyy",
  amountRounding: 2,
  sessionTimeoutMinutes: 30,
  posSessionTimeoutHours: 12,
  adjustmentApprovalThresholdPaisa: 1_000_000,
};

export function SettingsPage() {
  const [settings, setSettings] = useState<BusinessSettings>(defaults);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  useEffect(() => {
    void getBusinessSettings().then((result) => {
      setSettings(result);
      setLoaded(true);
    }).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Could not load settings"));
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const data = new FormData(event.currentTarget);
    try {
      const threshold = parseRupees(String(data.get("adjustmentApprovalThreshold")));
      const updated = await updateBusinessSettings({
        currency: "PKR",
        timezone: "Asia/Karachi",
        dateFormat: String(data.get("dateFormat")) as BusinessSettings["dateFormat"],
        amountRounding: 2,
        sessionTimeoutMinutes: Number(data.get("sessionTimeoutMinutes")),
        posSessionTimeoutHours: Number(data.get("posSessionTimeoutHours")),
        adjustmentApprovalThresholdPaisa: threshold,
      });
      setSettings(updated);
      setSuccess("Settings saved.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save settings");
    }
  }

  return <div className="content narrow">
    <PageTitle title="Settings" description="Foundation defaults for locale and session behaviour." />
    {error && <ErrorMessage>{error}</ErrorMessage>}
    {success && <SuccessMessage>{success}</SuccessMessage>}
    <form className="panel stack" onSubmit={submit}>
      <Field label="Currency"><TextInput value="PKR" readOnly /></Field>
      <Field label="Time zone"><TextInput value="Asia/Karachi" readOnly /></Field>
      <Field label="Date format"><SelectInput name="dateFormat" value={settings.dateFormat} onChange={(event) => setSettings({ ...settings, dateFormat: event.target.value as BusinessSettings["dateFormat"] })}>
        <option value="dd/MM/yyyy">DD/MM/YYYY</option><option value="MM/dd/yyyy">MM/DD/YYYY</option><option value="yyyy-MM-dd">YYYY-MM-DD</option>
      </SelectInput></Field>
      <Field label="Amount decimal places"><TextInput value="2" readOnly /></Field>
      <Field label="Back-office session expiry (minutes)"><TextInput name="sessionTimeoutMinutes" type="number" min={5} max={240} value={settings.sessionTimeoutMinutes} onChange={(event) => setSettings({ ...settings, sessionTimeoutMinutes: Number(event.target.value) })} /></Field>
      <Field label="POS session expiry (hours)"><TextInput name="posSessionTimeoutHours" type="number" min={1} max={24} value={settings.posSessionTimeoutHours} onChange={(event) => setSettings({ ...settings, posSessionTimeoutHours: Number(event.target.value) })} /></Field>
      <Field label="Stock adjustment approval above (PKR)"><MoneyInput name="adjustmentApprovalThreshold" pattern="[0-9,]+(\.[0-9]{1,2})?" key={settings.adjustmentApprovalThresholdPaisa} defaultValue={toPlainRupees(settings.adjustmentApprovalThresholdPaisa)} required /></Field>
      <button className="button primary" disabled={!loaded}>Save settings</button>
    </form>
  </div>;
}
