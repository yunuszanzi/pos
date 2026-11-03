import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatPkr } from "../../../shared/money";
import { getAllUnits } from "../../api/catalogueApi";
import { getStockValuation } from "../../api/inventoryApi";
import { getAllLocations } from "../../api/orgApi";
import { ErrorMessage, PageTitle, SelectInput, TextInput } from "../../app/FormElements";
import { groupDigits } from "./stockFormat";
import { StockTabs } from "./StockTabs";

const todayInKarachi = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(new Date());

export function ValuationPage() {
  const [asOf, setAsOf] = useState("");
  const [locationId, setLocationId] = useState("");
  const locations = useQuery({ queryKey: ["locations"], queryFn: getAllLocations, staleTime: 5 * 60_000 });
  const units = useQuery({ queryKey: ["units"], queryFn: getAllUnits, staleTime: 5 * 60_000 });
  const valuation = useQuery({ queryKey: ["valuation", { asOf, locationId }], queryFn: () => getStockValuation({ asOf, locationId }) });

  const unitName = (unitId: string) => units.data?.find((unit) => unit.id === unitId)?.name ?? "";
  const rows = valuation.data?.rows ?? [];

  return <div className="content">
    <PageTitle title="Stock valuation" description="What the stock on hand is worth, at cost and at sale price, as of the end of any day." />
    <StockTabs />
    {valuation.isError && <ErrorMessage>{valuation.error.message}</ErrorMessage>}
    <section className="panel stack">
      <div className="form-actions">
        <label className="field"><span>As of</span><TextInput type="date" max={todayInKarachi()} value={asOf} onChange={(event) => setAsOf(event.target.value)} /></label>
        <label className="field"><span>Location</span>
          <SelectInput value={locationId} onChange={(event) => setLocationId(event.target.value)}>
            <option value="">All locations</option>
            {(locations.data ?? []).map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
          </SelectInput>
        </label>
      </div>
      {valuation.data && <p>
        <strong>At cost: {formatPkr(valuation.data.totals.costValuePaisa)}</strong> · <strong>At sale price: {formatPkr(valuation.data.totals.saleValuePaisa)}</strong>
        {" "}<span className="muted">({valuation.data.asOf ? `end of ${valuation.data.asOf}` : "now"}; sale value uses today's prices)</span>
      </p>}
      <div className="table-scroll"><table>
        <thead><tr><th>Product</th><th>SKU</th><th>On hand</th><th>Cost value</th><th>Sale price</th><th>Sale value</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={row.variantId}>
          <td><strong>{row.productName}</strong>{row.variantName && <small className="muted"> · {row.variantName}</small>}</td>
          <td className="mono">{row.sku}</td>
          <td>{groupDigits(row.onHand)} {unitName(row.baseUnitId)}</td>
          <td>{formatPkr(row.costValuePaisa)}</td>
          <td>{formatPkr(row.salePricePaisa)}</td>
          <td>{formatPkr(row.saleValuePaisa)}</td>
        </tr>)}</tbody>
      </table></div>
      {valuation.isPending && <p className="muted">Calculating…</p>}
      {valuation.data && !rows.length && <p className="muted">No stock on hand for this date.</p>}
    </section>
  </div>;
}
