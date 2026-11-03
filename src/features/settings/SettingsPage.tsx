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
  taxMode: "inclusive",
  cashRoundingPaisa: 0,
  allowNegativeStock: false,
  autoPrintReceipt: true,
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
        taxMode: settings.taxMode,
        cashRoundingPaisa: settings.cashRoundingPaisa,
        allowNegativeStock: settings.allowNegativeStock,
        autoPrintReceipt: settings.autoPrintReceipt,
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
      <Field label="Prices">
        <SelectInput value={settings.taxMode} onChange={(event) => setSettings({ ...settings, taxMode: event.target.value as BusinessSettings["taxMode"] })}>
          <option value="inclusive">Include tax (shelf prices)</option><option value="exclusive">Exclude tax (tax added at the end)</option>
        </SelectInput>
      </Field>
      <Field label="Round cash totals to">
        <SelectInput value={settings.cashRoundingPaisa} onChange={(event) => setSettings({ ...settings, cashRoundingPaisa: Number(event.target.value) as BusinessSettings["cashRoundingPaisa"] })}>
          <option value={0}>No rounding</option><option value={100}>Nearest Rs 1</option><option value={500}>Nearest Rs 5</option><option value={1000}>Nearest Rs 10</option>
        </SelectInput>
      </Field>
      <label className="checkbox-row"><input type="checkbox" checked={settings.allowNegativeStock} onChange={(event) => setSettings({ ...settings, allowNegativeStock: event.target.checked })} /><span><strong>Allow selling below zero stock</strong><small>Off: a sale of more than is on hand is refused.</small></span></label>
      <label className="checkbox-row"><input type="checkbox" checked={settings.autoPrintReceipt} onChange={(event) => setSettings({ ...settings, autoPrintReceipt: event.target.checked })} /><span><strong>Print the receipt after each sale</strong></span></label>
      <button className="button primary" disabled={!loaded}>Save settings</button>
    </form>
  </div>;
}
